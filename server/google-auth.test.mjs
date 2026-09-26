import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.mjs';

async function harness(t) {
  const folder = await mkdtemp(join(tmpdir(), 'crewyard-google-test-'));
  const server = createApp({
    filePath: join(folder, 'board.json'), googleClientId: 'crewyard-test-client',
    verifyGoogleToken: async (credential, audience) => {
      assert.equal(audience, 'crewyard-test-client');
      return JSON.parse(credential);
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(folder, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, { method = 'GET', json, cookies = [] } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(json ? { 'content-type': 'application/json', origin: base } : {}),
        ...(cookies.length ? { cookie: cookies.join('; ') } : {}),
      },
      body: json && JSON.stringify(json),
    });
    return { status: response.status, data: await response.json(), cookies: response.headers.getSetCookie().map(value => value.split(';')[0]) };
  }
  async function google(email, subject, cookies = [], overrides = {}) {
    const config = await request('/api/auth/google/config');
    assert.equal(config.data.enabled, true);
    const claims = { nonce: config.data.nonce, sub: subject, email, email_verified: true, name: 'Google Owner', ...overrides };
    return { credential: JSON.stringify(claims), cookies: [...cookies, ...config.cookies] };
  }
  return { request, google };
}

test('Google creates one CrewYard account and recognizes its subject on later sign-in', async t => {
  const { request, google } = await harness(t);
  const first = await google('owner@example.com', 'google-sub-1');
  const created = await request('/api/auth/google', { method: 'POST', json: { credential: first.credential }, cookies: first.cookies });
  assert.equal(created.status, 200);
  assert.equal(created.data.created, true);
  assert.equal(created.data.workspaces.length, 1);
  const userId = created.data.user.id;
  const second = await google('owner@example.com', 'google-sub-1');
  const again = await request('/api/auth/google', { method: 'POST', json: { credential: second.credential }, cookies: second.cookies });
  assert.equal(again.status, 200);
  assert.equal(again.data.created, false);
  assert.equal(again.data.user.id, userId);
  assert.equal(again.data.workspaces[0].id, created.data.workspaces[0].id);
  assert.equal((await request('/api/auth/me', { cookies: again.cookies })).data.actor.id, userId);
});

test('matching email does not silently link an existing password account', async t => {
  const { request, google } = await harness(t);
  const registered = await request('/api/auth/register', { method: 'POST', json: {
    name: 'Owner', email: 'existing@example.com', password: 'long-password-123', workspaceName: 'Original workspace',
  } });
  assert.equal(registered.status, 201);
  const signIn = await google('existing@example.com', 'google-sub-2');
  const blocked = await request('/api/auth/google', { method: 'POST', json: { credential: signIn.credential }, cookies: signIn.cookies });
  assert.equal(blocked.status, 409);
  const link = await google('existing@example.com', 'google-sub-2', registered.cookies);
  const linked = await request('/api/auth/google/link', { method: 'POST', json: { credential: link.credential }, cookies: link.cookies });
  assert.equal(linked.status, 200);
  const returning = await google('existing@example.com', 'google-sub-2');
  const loggedIn = await request('/api/auth/google', { method: 'POST', json: { credential: returning.credential }, cookies: returning.cookies });
  assert.equal(loggedIn.status, 200);
  assert.equal(loggedIn.data.user.id, registered.data.user.id);
  assert.equal(loggedIn.data.workspaces[0].id, registered.data.workspaces[0].id);
});

test('Google sign-in rejects mismatched nonce and linking a different email', async t => {
  const { request, google } = await harness(t);
  const bad = await google('new@example.com', 'google-sub-3', [], { nonce: 'wrong' });
  assert.equal((await request('/api/auth/google', { method: 'POST', json: { credential: bad.credential }, cookies: bad.cookies })).status, 401);
  const registered = await request('/api/auth/register', { method: 'POST', json: {
    name: 'Owner', email: 'owner@example.com', password: 'long-password-123', workspaceName: 'Original workspace',
  } });
  const other = await google('other@example.com', 'google-sub-4', registered.cookies);
  assert.equal((await request('/api/auth/google/link', { method: 'POST', json: { credential: other.credential }, cookies: other.cookies })).status, 409);
});
