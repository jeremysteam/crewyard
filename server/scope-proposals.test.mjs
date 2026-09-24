import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.mjs';

async function harness(t) {
  const folder = await mkdtemp(join(tmpdir(), 'common-ground-scope-'));
  const server = createApp({ filePath: join(folder, 'board.json') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(folder, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (path, { method = 'GET', cookie, token, json } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json ? { 'content-type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : undefined });
    return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], data: await response.json() };
  };
}

const brief = { purpose: 'Ship a helpful product', workContext: 'Prototype first', constraints: 'No production access', definitionOfDone: 'Pilot approved' };

test('agent scope draft is isolated and owner applies edited brief with audit history', async t => {
  const call = await harness(t);
  const owner = await call('/api/auth/register', { method: 'POST', json: { name: 'Owner', email: 'scope-owner@example.com', password: 'long-password-123' } });
  const workspace = owner.data.workspaces[0].id;
  const root = (await call(`/api/workspaces/${workspace}/projects`, { method: 'POST', cookie: owner.cookie, json: { name: 'Music Video Generator' } })).data;
  const child = (await call(`/api/workspaces/${workspace}/projects`, { method: 'POST', cookie: owner.cookie, json: { name: 'Song understanding', parentProjectId: root.id } })).data;
  const other = (await call(`/api/workspaces/${workspace}/projects`, { method: 'POST', cookie: owner.cookie, json: { name: 'CommonGround' } })).data;
  const agent = await call(`/api/workspaces/${workspace}/agents`, { method: 'POST', cookie: owner.cookie, json: { name: 'manager-agent', rootProjectId: root.id } });
  const otherAgent = await call(`/api/workspaces/${workspace}/agents`, { method: 'POST', cookie: owner.cookie, json: { name: 'other-manager', rootProjectId: other.id } });
  const path = `/api/projects/${root.id}/scope-proposals`;
  assert.equal((await call(path, { method: 'POST', cookie: owner.cookie, json: { brief, plan: 'Create a story board' } })).status, 403);
  assert.equal((await call(`/api/projects/${child.id}/scope-proposals`, { method: 'POST', token: agent.data.token, json: { brief } })).status, 403);
  assert.equal((await call(`/api/projects/${other.id}/scope-proposals`, { method: 'POST', token: agent.data.token, json: { brief } })).status, 404);
  const draft = await call(path, { method: 'POST', token: agent.data.token, json: { brief, plan: 'Start with song understanding, then visual direction.' } });
  assert.equal(draft.status, 201);
  assert.equal((await call(`/api/projects/${root.id}`, { token: agent.data.token })).data.brief.purpose, '');
  assert.equal((await call(path, { token: otherAgent.data.token })).status, 404);
  assert.equal((await call(`${path}/${draft.data.id}`, { token: otherAgent.data.token })).status, 404);
  assert.equal((await call(`${path}/${draft.data.id}/decision`, { method: 'POST', token: agent.data.token, json: { decision: 'approve' } })).status, 403);
  const edited = { ...brief, purpose: 'Ship an excellent product' };
  const applied = await call(`${path}/${draft.data.id}/decision`, { method: 'POST', cookie: owner.cookie, json: { decision: 'approve', brief: edited, plan: 'First song map, then visuals', reason: '' } });
  assert.equal(applied.status, 200);
  assert.deepEqual(applied.data.brief, brief);
  assert.deepEqual(applied.data.appliedBrief, edited);
  assert.equal(applied.data.status, 'approved');
  assert.equal((await call(`/api/projects/${root.id}`, { cookie: owner.cookie })).data.scopePlan, 'First song map, then visuals');
  assert.equal((await call(`${path}/${draft.data.id}/decision`, { method: 'POST', cookie: owner.cookie, json: { decision: 'reject', reason: 'Again' } })).status, 409);
  const history = (await call(path, { cookie: owner.cookie })).data;
  assert.equal(history.length, 1);
  assert.equal(history[0].decidedBy.type, 'user');
  const activity = (await call(`/api/projects/${root.id}/activity`, { cookie: owner.cookie })).data;
  assert.ok(activity.some(item => item.action === 'project.scope_proposed'));
  assert.ok(activity.some(item => item.action === 'project.scope_approved'));
});

test('rejection preserves official scope and stale drafts cannot overwrite owner edits', async t => {
  const call = await harness(t);
  const owner = await call('/api/auth/register', { method: 'POST', json: { name: 'Owner', email: 'scope-reject@example.com', password: 'long-password-123' } });
  const workspace = owner.data.workspaces[0].id;
  const root = (await call(`/api/workspaces/${workspace}/projects`, { method: 'POST', cookie: owner.cookie, json: { name: 'Product' } })).data;
  const agent = await call(`/api/workspaces/${workspace}/agents`, { method: 'POST', cookie: owner.cookie, json: { name: 'scope-agent', rootProjectId: root.id } });
  const path = `/api/projects/${root.id}/scope-proposals`;
  const first = (await call(path, { method: 'POST', token: agent.data.token, json: { brief, plan: 'Outline' } })).data;
  assert.equal((await call(`${path}/${first.id}/decision`, { method: 'POST', cookie: owner.cookie, json: { decision: 'reject' } })).status, 400);
  const rejected = await call(`${path}/${first.id}/decision`, { method: 'POST', cookie: owner.cookie, json: { decision: 'reject', reason: 'Need a clearer pilot' } });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.data.status, 'rejected');
  assert.equal((await call(`/api/projects/${root.id}`, { cookie: owner.cookie })).data.brief.purpose, '');
  const second = (await call(path, { method: 'POST', token: agent.data.token, json: { brief } })).data;
  const ownerBrief = { ...brief, purpose: 'Owner revision' };
  assert.equal((await call(`/api/projects/${root.id}/brief`, { method: 'PATCH', cookie: owner.cookie, json: ownerBrief })).status, 200);
  const stale = await call(`${path}/${second.id}/decision`, { method: 'POST', cookie: owner.cookie, json: { decision: 'approve' } });
  assert.equal(stale.status, 409);
  assert.equal((await call(`${path}/${second.id}`, { token: agent.data.token })).data.status, 'pending');
  assert.equal((await call(`/api/projects/${root.id}`, { cookie: owner.cookie })).data.brief.purpose, 'Owner revision');
});
