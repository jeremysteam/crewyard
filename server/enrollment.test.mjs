import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.mjs';

async function harness(t) {
  const folder = await mkdtemp(join(tmpdir(), 'common-ground-enroll-'));
  const filePath = join(folder, 'board.json');
  const server = createApp({ filePath });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(folder, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, { method = 'GET', json, cookie, token } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(json ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: json && JSON.stringify(json) });
    return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], data: await response.json() };
  };
  const owner = await request('/api/auth/register', { method: 'POST', json: { name: 'Owner', email: 'owner@example.test', password: 'long-password-123', workspaceName: 'Test' } });
  const workspaceId = owner.data.workspaces[0].id;
  const createProject = (name, parentProjectId) => request(`/api/workspaces/${workspaceId}/projects`, { method: 'POST', cookie: owner.cookie, json: { name, parentProjectId } });
  const first = await createProject('First');
  const second = await createProject('Second');
  const feature = await createProject('Feature', first.data.id);
  return { request, owner, workspaceId, first: first.data.id, second: second.data.id, feature: feature.data.id, filePath };
}

test('one-use invite enrolls a scoped agent once without exposing its secret', async t => {
  const h = await harness(t);
  const path = `/api/projects/${h.first}/agent-invites`;
  assert.equal((await h.request(path, { method: 'POST', json: {} })).status, 401);
  assert.equal((await h.request(`/api/projects/${h.feature}/agent-invites`, { method: 'POST', cookie: h.owner.cookie, json: {} })).status, 400);
  assert.equal((await h.request(path, { method: 'POST', cookie: h.owner.cookie, json: { maxUses: 6 } })).status, 400);
  const created = await h.request(path, { method: 'POST', cookie: h.owner.cookie, json: {} });
  assert.equal(created.status, 201);
  assert.equal(created.data.secret.length, 43);
  assert.equal(created.data.invite.maxUses, 1);
  assert.equal(created.data.invite.secretHash, undefined);
  const listed = await h.request(path, { cookie: h.owner.cookie });
  assert.equal(listed.data[0].secretHash, undefined);
  assert.equal(JSON.stringify(await readFile(h.filePath, 'utf8')).includes(created.data.secret), false);
  const joined = await h.request('/api/agent-enrollments', { method: 'POST', json: { invite: created.data.secret, rootProjectId: h.second, workspaceId: 'untrusted' } });
  assert.equal(joined.status, 201);
  assert.match(joined.data.agent.name, /^agent-/);
  assert.equal(joined.data.agent.rootProjectId, h.first);
  assert.equal((await readFile(h.filePath, 'utf8')).includes(joined.data.token), false);
  assert.equal((await h.request('/api/agent-enrollments', { method: 'POST', json: { invite: created.data.secret } })).status, 401);
  assert.equal((await h.request(`/api/projects/${h.first}`, { token: joined.data.token })).status, 200);
  assert.equal((await h.request(`/api/projects/${h.feature}`, { token: joined.data.token })).status, 200);
  assert.equal((await h.request(`/api/projects/${h.second}`, { token: joined.data.token })).status, 404);
  assert.equal((await h.request(`/api/projects/${h.second}/jobs`, { method: 'POST', token: joined.data.token, json: { title: 'Out of scope' } })).status, 404);
  assert.equal((await h.request(path, { token: joined.data.token })).status, 403);
  const audit = await h.request(`/api/projects/${h.first}/activity`, { cookie: h.owner.cookie });
  assert.ok(audit.data.some(event => event.action === 'agent.joined'));
  const after = await h.request(path, { cookie: h.owner.cookie });
  assert.equal(after.data[0].redemptions[0].agentId, joined.data.agent.id);
  assert.equal((await h.request(`/api/workspaces/${h.workspaceId}/agents/${joined.data.agent.id}`, { method: 'DELETE', cookie: h.owner.cookie })).status, 200);
  assert.equal((await h.request('/api/auth/me', { token: joined.data.token })).status, 401);
});

test('revocation and expiry stop redemption but do not revoke an already enrolled agent', async t => {
  const h = await harness(t);
  const path = `/api/projects/${h.first}/agent-invites`;
  const invite = await h.request(path, { method: 'POST', cookie: h.owner.cookie, json: { maxUses: 2, expiresMinutes: 5 } });
  const joined = await h.request('/api/agent-enrollments', { method: 'POST', json: { invite: invite.data.secret, name: 'builder' } });
  assert.equal(joined.status, 201);
  assert.equal((await h.request(`${path}/${invite.data.invite.id}`, { method: 'DELETE', cookie: h.owner.cookie })).status, 200);
  assert.equal((await h.request('/api/agent-enrollments', { method: 'POST', json: { invite: invite.data.secret } })).status, 401);
  assert.equal((await h.request('/api/auth/me', { token: joined.data.token })).status, 200);
  const expiring = await h.request(path, { method: 'POST', cookie: h.owner.cookie, json: { expiresMinutes: 5 } });
  const data = JSON.parse(await readFile(h.filePath, 'utf8'));
  data.agentInvites.find(entry => entry.id === expiring.data.invite.id).expiresAt = new Date(Date.now() - 1000).toISOString();
  await writeFile(h.filePath, JSON.stringify(data));
  assert.equal((await h.request('/api/agent-enrollments', { method: 'POST', json: { invite: expiring.data.secret } })).status, 401);
});

test('concurrent batch redemption respects cap and resolves agent name collisions', async t => {
  const h = await harness(t);
  const created = await h.request(`/api/projects/${h.first}/agent-invites`, { method: 'POST', cookie: h.owner.cookie, json: { maxUses: 2 } });
  const results = await Promise.all(Array.from({ length: 5 }, () => h.request('/api/agent-enrollments', { method: 'POST', json: { invite: created.data.secret, name: 'same-name' } })));
  assert.equal(results.filter(result => result.status === 201).length, 2);
  assert.equal(results.filter(result => result.status === 401).length, 3);
  const names = results.filter(result => result.status === 201).map(result => result.data.agent.name);
  assert.equal(new Set(names).size, 2);
  const listed = await h.request(`/api/projects/${h.first}/agent-invites`, { cookie: h.owner.cookie });
  assert.equal(listed.data[0].useCount, 2);
  assert.equal(listed.data[0].redemptions.length, 2);
});

test('invalid enrollment input is rejected and failed invite guesses are rate limited', async t => {
  const h = await harness(t);
  assert.equal((await h.request('/api/agent-enrollments?invite=secret', { method: 'POST', json: { invite: 'x' } })).status, 400);
  assert.equal((await h.request('/api/agent-enrollments', { method: 'POST', json: { invite: 'x', name: '!' } })).status, 400);
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal((await h.request('/api/agent-enrollments', { method: 'POST', json: { invite: 'x' } })).status, 401);
  }
  assert.equal((await h.request('/api/agent-enrollments', { method: 'POST', json: { invite: 'x' } })).status, 429);
});
