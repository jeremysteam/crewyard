import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from './app.mjs';
import { createStore } from './store.mjs';

const execFile = promisify(execFileCallback);

async function harness(t, makeStore) {
  const folder = await mkdtemp(join(tmpdir(), 'common-ground-test-'));
  const filePath = join(folder, 'board.json');
  const server = createApp({ filePath, store: makeStore?.(filePath) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(folder, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, { method = 'GET', json, cookie, token } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(json ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: json && JSON.stringify(json) });
    return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], data: await response.json() };
  }
  request.base = base;
  request.folder = folder;
  return request;
}

test('user connects an agent and reviews its claimed work', async t => {
  const request = await harness(t);
  const signup = await request('/api/auth/register', { method: 'POST', json: { name: 'Jeremy', email: 'jeremy@example.com', password: 'long-password-123', workspaceName: 'Studio' } });
  assert.equal(signup.status, 201);
  const cookie = signup.cookie;
  const workspaceId = signup.data.workspaces[0].id;
  const project = await request(`/api/workspaces/${workspaceId}/projects`, { method: 'POST', cookie, json: { name: 'Launch', description: 'Ship the first version' } });
  const projectId = project.data.id;
  const connected = await request(`/api/workspaces/${workspaceId}/agents`, { method: 'POST', cookie, json: { name: 'codex-builder', rootProjectId: projectId } });
  assert.equal(connected.status, 201);
  const token = connected.data.token;
  const created = await request(`/api/projects/${projectId}/jobs`, { method: 'POST', cookie, json: { title: 'Build onboarding', body: 'Create the first run flow' } });
  assert.equal(created.status, 201);
  const jobId = created.data.id;
  const claim = await request(`/api/jobs/${jobId}/claim`, { method: 'POST', token });
  assert.equal(claim.status, 200);
  assert.equal(claim.data.assignee.name, 'codex-builder');
  assert.equal((await request(`/api/jobs/${jobId}/claim`, { method: 'POST', token })).status, 409);
  const comment = await request(`/api/jobs/${jobId}/comments`, { method: 'POST', token, json: { body: '@jeremy the first run is ready to review.' } });
  assert.equal(comment.status, 201);
  assert.equal((await request('/api/mentions', { cookie })).data.unread, 1);
  const review = await request(`/api/jobs/${jobId}/move`, { method: 'POST', token, json: { status: 'review', comment: 'Ran the onboarding flow.' } });
  assert.equal(review.status, 200);
  assert.equal((await request(`/api/jobs/${jobId}/move`, { method: 'POST', token, json: { status: 'completed', comment: 'Self approved.' } })).status, 403);
  const approved = await request(`/api/jobs/${jobId}/move`, { method: 'POST', cookie, json: { status: 'completed', comment: 'Verified the first run.' } });
  assert.equal(approved.status, 200);
  assert.equal(approved.data.status, 'completed');
  const feed = await request(`/api/projects/${projectId}/activity?since=0`, { token });
  assert.ok(feed.data.some(a => a.action === 'job.claimed'));
  assert.ok(feed.data.some(a => a.action === 'job.moved'));
});

test('agents cannot read or modify another workspace', async t => {
  const request = await harness(t);
  const first = await request('/api/auth/register', { method: 'POST', json: { name: 'Owner One', email: 'one@example.com', password: 'long-password-123', workspaceName: 'One' } });
  const second = await request('/api/auth/register', { method: 'POST', json: { name: 'Owner Two', email: 'two@example.com', password: 'long-password-456', workspaceName: 'Two' } });
  const firstWorkspace = first.data.workspaces[0].id;
  const firstProject = await request(`/api/workspaces/${firstWorkspace}/projects`, { method: 'POST', cookie: first.cookie, json: { name: 'First project' } });
  const agent = await request(`/api/workspaces/${firstWorkspace}/agents`, { method: 'POST', cookie: first.cookie, json: { name: 'agent-one', rootProjectId: firstProject.data.id } });
  const otherProject = await request(`/api/workspaces/${second.data.workspaces[0].id}/projects`, { method: 'POST', cookie: second.cookie, json: { name: 'Private project' } });
  assert.equal((await request(`/api/projects/${otherProject.data.id}`, { token: agent.data.token })).status, 404);
  assert.equal((await request(`/api/projects/${otherProject.data.id}/jobs`, { method: 'POST', token: agent.data.token, json: { title: 'Intrusion' } })).status, 404);
  assert.equal((await request(`/api/projects/${otherProject.data.id}`, { cookie: first.cookie })).status, 404);
});

test('votes are unique per actor and mention inbox can be acknowledged', async t => {
  const request = await harness(t);
  const owner = await request('/api/auth/register', { method: 'POST', json: { name: 'Board Owner', email: 'owner@example.com', password: 'long-password-123', workspaceName: 'Board' } });
  const workspaceId = owner.data.workspaces[0].id;
  const project = await request(`/api/workspaces/${workspaceId}/projects`, { method: 'POST', cookie: owner.cookie, json: { name: 'Research' } });
  const agent = await request(`/api/workspaces/${workspaceId}/agents`, { method: 'POST', cookie: owner.cookie, json: { name: 'research-agent', rootProjectId: project.data.id } });
  const job = await request(`/api/projects/${project.data.id}/jobs`, { method: 'POST', cookie: owner.cookie, json: { title: 'Check the idea' } });
  await request(`/api/jobs/${job.data.id}/votes`, { method: 'POST', token: agent.data.token, json: { value: 1, reason: 'Worth trying' } });
  await request(`/api/jobs/${job.data.id}/votes`, { method: 'POST', token: agent.data.token, json: { value: -1, reason: 'Evidence changed' } });
  const detail = await request(`/api/jobs/${job.data.id}`, { cookie: owner.cookie });
  assert.equal(detail.data.votes.length, 1);
  assert.equal(detail.data.votes[0].value, -1);
  await request(`/api/jobs/${job.data.id}/comments`, { method: 'POST', cookie: owner.cookie, json: { body: '@research-agent please look again.' } });
  assert.equal((await request('/api/mentions', { token: agent.data.token })).data.unread, 1);
  await request('/api/mentions/read', { method: 'POST', token: agent.data.token, json: {} });
  assert.equal((await request('/api/mentions', { token: agent.data.token })).data.unread, 0);
});

test('manager pause and assignment are enforced while agents can acknowledge announcements', async t => {
  const request = await harness(t);
  const owner = await request('/api/auth/register', { method: 'POST', json: { name: 'Owner', email: 'coord-owner@example.com', password: 'long-password-123', workspaceName: 'Team' } });
  const workspaceId = owner.data.workspaces[0].id;
  const project = await request(`/api/workspaces/${workspaceId}/projects`, { method: 'POST', cookie: owner.cookie, json: { name: 'Delivery' } });
  const agents = [];
  for (const name of ['manager', 'worker', 'other']) agents.push((await request(`/api/workspaces/${workspaceId}/agents`, { method: 'POST', cookie: owner.cookie, json: { name, rootProjectId: project.data.id } })).data);
  const [manager, worker, other] = agents;
  const job = await request(`/api/projects/${project.data.id}/jobs`, { method: 'POST', cookie: owner.cookie, json: { title: 'Build feature' } });
  assert.equal((await request(`/api/workspaces/${workspaceId}/announcements`, { method: 'POST', token: manager.token, json: { kind: 'pause', body: 'Stop @allagents' } })).status, 403);
  assert.equal((await request(`/api/workspaces/${workspaceId}/agents/${manager.agent.id}/manager`, { method: 'PATCH', token: manager.token, json: { canManage: true } })).status, 403);
  assert.equal((await request(`/api/workspaces/${workspaceId}/agents/${manager.agent.id}/manager`, { method: 'PATCH', cookie: owner.cookie, json: { canManage: true } })).status, 200);
  const assigned = await request(`/api/workspaces/${workspaceId}/announcements`, { method: 'POST', token: manager.token, json: { kind: 'assignment', body: '@worker take the open job', targetAgentId: worker.agent.id, jobId: job.data.id } });
  assert.equal(assigned.status, 201);
  assert.equal((await request(`/api/jobs/${job.data.id}/claim`, { method: 'POST', token: other.token })).status, 403);
  assert.equal((await request('/api/mentions', { token: worker.token })).data.unread, 1);
  const stopped = await request(`/api/workspaces/${workspaceId}/announcements`, { method: 'POST', token: manager.token, json: { kind: 'pause', body: 'Stop now @allagents' } });
  assert.equal(stopped.status, 201);
  assert.equal(stopped.data.message.receipts.length, 3);
  assert.equal((await request(`/api/jobs/${job.data.id}/claim`, { method: 'POST', token: worker.token })).status, 423);
  const ack = await request(`/api/workspaces/${workspaceId}/announcements/${stopped.data.message.id}/ack`, { method: 'POST', token: worker.token });
  assert.equal(ack.status, 200);
  assert.equal((await request(`/api/workspaces/${workspaceId}/announcements`, { token: worker.token })).data.messages.at(-1).receipts.find(item => item.agentId === worker.agent.id).readAt, ack.data.readAt);
  assert.equal((await request(`/api/workspaces/${workspaceId}/announcements`, { method: 'POST', token: manager.token, json: { kind: 'resume', body: 'Keep going @allagents' } })).status, 201);
  assert.equal((await request(`/api/jobs/${job.data.id}/claim`, { method: 'POST', token: worker.token })).status, 200);
});

test('blind meeting answers stay private until all submit and auto mode follows votes', async t => {
  const request = await harness(t);
  const owner = await request('/api/auth/register', { method: 'POST', json: { name: 'Owner', email: 'meeting-owner@example.com', password: 'long-password-123', workspaceName: 'Board' } });
  const workspaceId = owner.data.workspaces[0].id;
  const project = await request(`/api/workspaces/${workspaceId}/projects`, { method: 'POST', cookie: owner.cookie, json: { name: 'Research' } });
  const agents = [];
  for (const name of ['main', 'claude', 'kimi']) agents.push((await request(`/api/workspaces/${workspaceId}/agents`, { method: 'POST', cookie: owner.cookie, json: { name, rootProjectId: project.data.id } })).data);
  const [main, claude, kimi] = agents;
  const made = await request(`/api/workspaces/${workspaceId}/meetings`, { method: 'POST', cookie: owner.cookie, json: { title: 'Architecture', prompt: 'Which design?', mainAgentId: main.agent.id, participantIds: agents.map(agent => agent.agent.id), mode: 'blind' } });
  assert.equal(made.status, 201);
  const meetingId = made.data.id, roundId = made.data.rounds[0].id;
  assert.equal((await request(`/api/meetings/${meetingId}/rounds/${roundId}/responses`, { method: 'POST', token: claude.token, json: { body: 'Use option A' } })).status, 201);
  const hidden = await request(`/api/meetings/${meetingId}`, { token: kimi.token });
  assert.equal(hidden.data.rounds[0].answerCount, 1);
  assert.equal(hidden.data.rounds[0].responses.length, 0);
  assert.equal((await request(`/api/meetings/${meetingId}/rounds/${roundId}/responses`, { method: 'POST', token: main.token, json: { body: 'My independent view' } })).status, 201);
  assert.equal((await request(`/api/meetings/${meetingId}`, { cookie: owner.cookie })).data.rounds[0].responses.length, 0);
  await request(`/api/meetings/${meetingId}/rounds/${roundId}/responses`, { method: 'POST', token: kimi.token, json: { body: 'Use option B' } });
  assert.equal((await request(`/api/meetings/${meetingId}`, { token: claude.token })).data.rounds[0].stage, 'synthesis');
  assert.equal((await request(`/api/meetings/${meetingId}`, { token: claude.token })).data.rounds[0].responses.length, 3);
  assert.equal((await request(`/api/meetings/${meetingId}/rounds/${roundId}/responses`, { method: 'POST', token: claude.token, json: { kind: 'synthesis', body: 'No' } })).status, 409);
  assert.equal((await request(`/api/meetings/${meetingId}/rounds/${roundId}/responses`, { method: 'POST', token: main.token, json: { kind: 'synthesis', body: 'A with one change' } })).status, 201);
  await request(`/api/meetings/${meetingId}`, { method: 'PATCH', cookie: owner.cookie, json: { autoMode: true } });
  for (const agent of agents) await request(`/api/meetings/${meetingId}/rounds/${roundId}/votes`, { method: 'POST', token: agent.token, json: { mode: agent === kimi ? 'open' : 'blind' } });
  const next = await request(`/api/meetings/${meetingId}`, { token: main.token });
  assert.equal(next.data.rounds.length, 2);
  assert.equal(next.data.rounds[1].mode, 'blind');
  assert.equal((await request('/api/meeting-memory', { method: 'PUT', token: claude.token, json: { body: 'Remember A' } })).status, 200);
  assert.equal((await request('/api/meeting-memory', { token: claude.token })).data.body, 'Remember A');
  assert.equal((await request('/api/meeting-memory', { token: claude.token })).data.history[0].answer, 'Use option A');
  assert.equal((await request('/api/meeting-memory', { token: kimi.token })).data.body, '');
});

test('open rounds put the main agent last and targeted rounds hear one agent', async t => {
  const request = await harness(t);
  const owner = await request('/api/auth/register', { method: 'POST', json: { name: 'Owner', email: 'open-owner@example.com', password: 'long-password-123', workspaceName: 'Board' } });
  const workspaceId = owner.data.workspaces[0].id;
  const project = await request(`/api/workspaces/${workspaceId}/projects`, { method: 'POST', cookie: owner.cookie, json: { name: 'Research' } });
  const main = (await request(`/api/workspaces/${workspaceId}/agents`, { method: 'POST', cookie: owner.cookie, json: { name: 'main', rootProjectId: project.data.id } })).data;
  const panel = (await request(`/api/workspaces/${workspaceId}/agents`, { method: 'POST', cookie: owner.cookie, json: { name: 'panel', rootProjectId: project.data.id } })).data;
  const made = await request(`/api/workspaces/${workspaceId}/meetings`, { method: 'POST', cookie: owner.cookie, json: { title: 'Open', prompt: 'What now?', mainAgentId: main.agent.id, participantIds: [main.agent.id, panel.agent.id], mode: 'open' } });
  const meetingId = made.data.id, roundId = made.data.rounds[0].id;
  assert.equal((await request(`/api/meetings/${meetingId}/rounds/${roundId}/responses`, { method: 'POST', token: main.token, json: { body: 'Too early' } })).status, 409);
  assert.equal((await request(`/api/meetings/${meetingId}/rounds/${roundId}/responses`, { method: 'POST', token: panel.token, json: { body: 'Panel view' } })).status, 201);
  assert.equal((await request(`/api/meetings/${meetingId}/rounds/${roundId}/responses`, { method: 'POST', token: main.token, json: { body: 'Main view' } })).status, 201);
  const targeted = await request(`/api/meetings/${meetingId}/rounds`, { method: 'POST', cookie: owner.cookie, json: { mode: 'targeted', targetAgentId: panel.agent.id, prompt: '@panel clarify' } });
  assert.equal(targeted.status, 201);
  assert.equal((await request(`/api/meetings/${meetingId}/rounds/${targeted.data.id}/responses`, { method: 'POST', token: main.token, json: { body: 'Not my turn' } })).status, 403);
  assert.equal((await request(`/api/meetings/${meetingId}/rounds/${targeted.data.id}/responses`, { method: 'POST', token: panel.token, json: { body: 'Clarification' } })).status, 201);
  assert.equal((await request(`/api/meetings/${meetingId}`, { cookie: owner.cookie })).data.rounds[1].stage, 'complete');
});

test('one-time folder pairing links a verified local directory without sharing files', async t => {
  const request = await harness(t);
  const owner = await request('/api/auth/register', { method: 'POST', json: { name: 'Folder Owner', email: 'folder@example.com', password: 'long-password-123', workspaceName: 'Folder workspace' } });
  const workspaceId = owner.data.workspaces[0].id;
  const project = await request(`/api/workspaces/${workspaceId}/projects`, { method: 'POST', cookie: owner.cookie, json: { name: 'Local work' } });
  const projectId = project.data.id;
  const agent = await request(`/api/workspaces/${workspaceId}/agents`, { method: 'POST', cookie: owner.cookie, json: { name: 'local-agent', rootProjectId: projectId } });
  const code = await request(`/api/projects/${projectId}/folder-pairings`, { method: 'POST', cookie: owner.cookie, json: {} });
  assert.equal(code.status, 201);
  const linked = await execFile(process.execPath, ['scripts/link-folder.mjs', '--project', projectId, '--path', request.folder, '--server', request.base, '--code', code.data.code], { cwd: process.cwd() });
  assert.match(linked.stdout, /No files were read or uploaded/);
  const folders = await request(`/api/projects/${projectId}/folders`, { token: agent.data.token });
  assert.equal(folders.status, 200);
  assert.equal(folders.data.length, 1);
  assert.equal(folders.data[0].path, await realpath(request.folder));
  assert.equal((await request('/api/folder-pairings/claim', { method: 'POST', json: { code: code.data.code, projectId, path: request.folder, machine: 'other' } })).status, 404);
  assert.equal((await request(`/api/projects/${projectId}/folder-pairings`, { method: 'POST', token: agent.data.token, json: {} })).status, 403);
  assert.equal((await request(`/api/projects/${projectId}/folders/${folders.data[0].id}`, { method: 'DELETE', cookie: owner.cookie })).status, 200);
  assert.equal((await request(`/api/projects/${projectId}/folders`, { token: agent.data.token })).data.length, 0);
});

test('owners save labeled work locations and scoped agents can read them', async t => {
  const request = await harness(t);
  const owner = await request('/api/auth/register', { method: 'POST', json: { name: 'Work Owner', email: 'locations@example.com', password: 'long-password-123', workspaceName: 'Studio' } });
  const workspaceId = owner.data.workspaces[0].id;
  const root = await request(`/api/workspaces/${workspaceId}/projects`, { method: 'POST', cookie: owner.cookie, json: { name: 'Music Video Generator' } });
  const child = await request(`/api/workspaces/${workspaceId}/projects`, { method: 'POST', cookie: owner.cookie, json: { name: 'Song Understanding', parentProjectId: root.data.id } });
  const other = await request(`/api/workspaces/${workspaceId}/projects`, { method: 'POST', cookie: owner.cookie, json: { name: 'Other product' } });
  const agent = await request(`/api/workspaces/${workspaceId}/agents`, { method: 'POST', cookie: owner.cookie, json: { name: 'music-agent', rootProjectId: root.data.id } });
  const rootJob = await request(`/api/projects/${root.data.id}/jobs`, { method: 'POST', cookie: owner.cookie, json: { title: 'Plan the video' } });
  const childJob = await request(`/api/projects/${child.data.id}/jobs`, { method: 'POST', cookie: owner.cookie, json: { title: 'Understand the song' } });
  const otherJob = await request(`/api/projects/${other.data.id}/jobs`, { method: 'POST', cookie: owner.cookie, json: { title: 'Private job' } });
  assert.deepEqual((await request(`/api/jobs/${childJob.data.id}`, { token: agent.data.token })).data.workLocations, []);
  const folder = await request(`/api/projects/${root.data.id}/work-locations`, { method: 'POST', cookie: owner.cookie, json: { label: 'Main repo', kind: 'folder', target: 'C:\\work\\music-video' } });
  const inherited = (await request(`/api/jobs/${childJob.data.id}`, { token: agent.data.token })).data.workLocations;
  assert.equal(inherited[0].target, 'C:\\work\\music-video');
  assert.equal(inherited[0].inherited, true);
  assert.equal(inherited[0].sourceProjectId, root.data.id);
  assert.equal((await request(`/api/jobs/${rootJob.data.id}`, { token: agent.data.token })).data.workLocations[0].inherited, false);
  assert.equal((await request(`/api/jobs/${otherJob.data.id}`, { token: agent.data.token })).status, 404);
  const link = await request(`/api/projects/${child.data.id}/work-locations`, { method: 'POST', cookie: owner.cookie, json: { label: 'Design notes', kind: 'link', target: 'https://example.com/docs' } });
  assert.equal(folder.status, 201);
  assert.equal(link.status, 201);
  assert.equal((await request(`/api/projects/${root.data.id}`, { token: agent.data.token })).data.workLocations[0].label, 'Main repo');
  assert.equal((await request(`/api/projects/${child.data.id}`, { token: agent.data.token })).data.workLocations[0].target, 'https://example.com/docs');
  assert.deepEqual((await request(`/api/jobs/${childJob.data.id}`, { token: agent.data.token })).data.workLocations.map(location => location.label), ['Design notes']);
  assert.equal((await request(`/api/projects/${child.data.id}/work-locations/${link.data.id}`, { method: 'DELETE', cookie: owner.cookie })).status, 200);
  assert.deepEqual((await request(`/api/jobs/${childJob.data.id}`, { token: agent.data.token })).data.workLocations.map(location => location.label), ['Main repo']);
  assert.equal((await request(`/api/projects/${other.data.id}`, { token: agent.data.token })).status, 404);
  assert.equal((await request(`/api/projects/${root.data.id}/work-locations`, { method: 'POST', token: agent.data.token, json: { label: 'Injected', kind: 'folder', target: 'C:\\private' } })).status, 403);
  assert.equal((await request(`/api/projects/${root.data.id}/work-locations`, { method: 'POST', cookie: owner.cookie, json: { label: 'Bad link', kind: 'link', target: 'javascript:alert(1)' } })).status, 400);
  assert.equal((await request(`/api/projects/${root.data.id}/work-locations`, { method: 'POST', cookie: owner.cookie, json: { label: 'Embedded password', kind: 'link', target: 'https://user:secret@example.com/repo' } })).status, 400);
  assert.equal((await request(`/api/projects/${root.data.id}/work-locations/${folder.data.id}`, { method: 'DELETE', cookie: owner.cookie })).status, 200);
  assert.equal((await request(`/api/projects/${root.data.id}`, { token: agent.data.token })).data.workLocations.length, 0);
  assert.deepEqual((await request(`/api/jobs/${childJob.data.id}`, { token: agent.data.token })).data.workLocations, []);
});

test('agents see only their top-level project and feature projects', async t => {
  const request = await harness(t);
  const owner = await request('/api/auth/register', { method: 'POST', json: { name: 'Project Owner', email: 'branches@example.com', password: 'long-password-123', workspaceName: 'Studio' } });
  const workspaceId = owner.data.workspaces[0].id;
  const createProject = (name, parentProjectId = null) => request(`/api/workspaces/${workspaceId}/projects`, { method: 'POST', cookie: owner.cookie, json: { name, parentProjectId } });
  const creator = await createProject('AI Creator U');
  const common = await createProject('CommonGround');
  const music = await createProject('Music Video Generator', creator.data.id);
  const onboarding = await createProject('Agent onboarding', common.data.id);
  assert.equal((await createProject('Too deep', music.data.id)).status, 400);
  assert.equal((await request(`/api/workspaces/${workspaceId}/agents`, { method: 'POST', cookie: owner.cookie, json: { name: 'unscoped' } })).status, 400);
  const artist = await request(`/api/workspaces/${workspaceId}/agents`, { method: 'POST', cookie: owner.cookie, json: { name: 'artist-agent', rootProjectId: creator.data.id } });
  const builder = await request(`/api/workspaces/${workspaceId}/agents`, { method: 'POST', cookie: owner.cookie, json: { name: 'builder-agent', rootProjectId: common.data.id } });
  assert.equal(artist.status, 201);
  assert.equal(builder.status, 201);
  const listed = await request(`/api/workspaces/${workspaceId}/projects`, { token: artist.data.token });
  assert.deepEqual(new Set(listed.data.map(p => p.name)), new Set(['AI Creator U', 'Music Video Generator']));
  assert.equal((await request(`/api/projects/${common.data.id}`, { token: artist.data.token })).status, 404);
  assert.equal((await request(`/api/projects/${onboarding.data.id}/folders`, { token: artist.data.token })).status, 404);
  assert.equal((await request(`/api/workspaces/${workspaceId}/agents`, { token: artist.data.token })).data.length, 1);
  assert.deepEqual((await request(`/api/workspaces/${workspaceId}/people`, { token: artist.data.token })).data.filter(p => p.type === 'agent').map(p => p.name), ['artist-agent']);
  assert.equal((await request(`/api/workspaces/${workspaceId}/projects`, { method: 'POST', token: artist.data.token, json: { name: 'New root' } })).status, 403);
  assert.equal((await request(`/api/workspaces/${workspaceId}/projects`, { method: 'POST', token: artist.data.token, json: { name: 'Wrong branch', parentProjectId: common.data.id } })).status, 403);
  assert.equal((await request(`/api/workspaces/${workspaceId}/projects`, { method: 'POST', token: artist.data.token, json: { name: 'New feature', parentProjectId: creator.data.id } })).status, 201);

  const privateJob = await request(`/api/projects/${onboarding.data.id}/jobs`, { method: 'POST', cookie: owner.cookie, json: { title: 'Build onboarding' } });
  assert.equal((await request(`/api/jobs/${privateJob.data.id}`, { token: artist.data.token })).status, 404);
  assert.equal((await request(`/api/jobs/${privateJob.data.id}/claim`, { method: 'POST', token: artist.data.token })).status, 404);
  assert.equal((await request(`/api/jobs/${privateJob.data.id}/comments`, { method: 'POST', token: artist.data.token, json: { body: 'Not my project' } })).status, 404);
  assert.equal((await request(`/api/jobs/${privateJob.data.id}/claim`, { method: 'POST', token: builder.data.token })).status, 200);
  await request(`/api/jobs/${privateJob.data.id}/comments`, { method: 'POST', cookie: owner.cookie, json: { body: '@artist-agent please look at this.' } });
  assert.equal((await request('/api/mentions', { token: artist.data.token })).data.unread, 0);

  const musicJob = await request(`/api/projects/${music.data.id}/jobs`, { method: 'POST', cookie: owner.cookie, json: { title: 'Connect video API' } });
  assert.equal((await request(`/api/jobs/${musicJob.data.id}/claim`, { method: 'POST', token: artist.data.token })).status, 200);
  assert.equal((await request(`/api/jobs/${musicJob.data.id}/move`, { method: 'POST', token: artist.data.token, json: { status: 'review', comment: 'Ready for review.' } })).status, 200);
  await request(`/api/jobs/${musicJob.data.id}/comments`, { method: 'POST', cookie: owner.cookie, json: { body: '@artist-agent please check the result.' } });
  assert.equal((await request('/api/mentions', { token: artist.data.token })).data.unread, 1);
  const parent = await request(`/api/projects/${creator.data.id}`, { token: artist.data.token });
  assert.equal(parent.data.childProjects.length, 2);
  assert.equal(parent.data.rollupCounts.review, 1);
  assert.equal(parent.data.counts.review, 0);
  assert.equal((await request(`/api/projects/${creator.data.id}/activity`, { token: artist.data.token })).data.some(a => a.jobId === musicJob.data.id && a.action === 'job.moved'), true);
  assert.equal((await request(`/api/projects/${common.data.id}/activity`, { token: artist.data.token })).status, 404);
});

test('legacy workspace-wide agent tokens are rejected until reconnected to a project', async t => {
  const request = await harness(t);
  const owner = await request('/api/auth/register', { method: 'POST', json: { name: 'Legacy Owner', email: 'legacy@example.com', password: 'long-password-123', workspaceName: 'Legacy' } });
  const filePath = join(request.folder, 'board.json');
  const data = JSON.parse(await readFile(filePath, 'utf8'));
  const oldToken = 'old-agent-token';
  data.agents.push({ id: 'old-agent', workspaceId: owner.data.workspaces[0].id, name: 'old-agent', tokenHash: createHash('sha256').update(oldToken).digest('hex'), createdAt: new Date().toISOString(), revokedAt: null });
  await writeFile(filePath, JSON.stringify(data));
  assert.equal((await request('/api/workspaces', { token: oldToken })).status, 401);
  assert.equal((await request('/api/workspaces', { token: oldToken, cookie: owner.cookie })).status, 401);
  assert.equal((await request(`/api/workspaces/${owner.data.workspaces[0].id}/people`, { cookie: owner.cookie })).data.some(person => person.name === 'old-agent'), true);
});

test('Needs you keeps decisions on jobs and isolates top-level project branches', async t => {
  const request = await harness(t);
  const owner = await request('/api/auth/register', { method: 'POST', json: { name: 'Product Owner', email: 'needs-owner@example.com', password: 'long-password-123', workspaceName: 'Studio' } });
  const otherOwner = await request('/api/auth/register', { method: 'POST', json: { name: 'Other Owner', email: 'needs-other@example.com', password: 'long-password-456', workspaceName: 'Other' } });
  const workspaceId = owner.data.workspaces[0].id;
  const makeProject = (name, parentProjectId = null) => request(`/api/workspaces/${workspaceId}/projects`, { method: 'POST', cookie: owner.cookie, json: { name, parentProjectId } });
  const root = (await makeProject('CommonGround')).data;
  const feature = (await makeProject('Agent onboarding', root.id)).data;
  const privateRoot = (await makeProject('AI Creator U')).data;
  const agent = await request(`/api/workspaces/${workspaceId}/agents`, { method: 'POST', cookie: owner.cookie, json: { name: 'builder-agent', rootProjectId: root.id } });
  const privateAgent = await request(`/api/workspaces/${workspaceId}/agents`, { method: 'POST', cookie: owner.cookie, json: { name: 'private-agent', rootProjectId: privateRoot.id } });
  const job = (await request(`/api/projects/${feature.id}/jobs`, { method: 'POST', cookie: owner.cookie, json: { title: 'Build onboarding' } })).data;
  const unrelated = (await request(`/api/projects/${privateRoot.id}/jobs`, { method: 'POST', cookie: owner.cookie, json: { title: 'Private work' } })).data;
  const ask = (jobId, token, question = 'Which flow should lead?') => request(`/api/jobs/${jobId}/requests`, { method: 'POST', token, json: { kind: 'blocker', question, context: 'The two drafts conflict.', recommendation: 'Use the shorter flow.' } });
  await request(`/api/jobs/${unrelated.id}/claim`, { method: 'POST', token: privateAgent.data.token });
  const privateRequest = await ask(unrelated.id, privateAgent.data.token, 'Private decision');
  assert.equal(privateRequest.status, 201);

  assert.equal((await ask(job.id, agent.data.token)).status, 409);
  assert.equal((await request(`/api/jobs/${job.id}/claim`, { method: 'POST', token: agent.data.token })).status, 200);
  await request(`/api/jobs/${job.id}/comments`, { method: 'POST', token: agent.data.token, json: { body: 'Routine progress on the draft.' } });
  const first = await ask(job.id, agent.data.token);
  assert.equal(first.status, 201);
  assert.equal((await ask(job.id, agent.data.token)).status, 409);
  assert.equal((await request(`/api/jobs/${job.id}/requests`, { method: 'POST', cookie: owner.cookie, json: { kind: 'question', question: 'Owner asks', context: 'Context' } })).status, 403);
  assert.equal((await ask(job.id, privateAgent.data.token)).status, 404);
  assert.equal((await request(`/api/projects/${root.id}/needs-you`, { token: agent.data.token })).status, 403);
  assert.equal((await request(`/api/projects/${root.id}/needs-you`, { cookie: otherOwner.cookie })).status, 404);
  const inbox = await request(`/api/projects/${root.id}/needs-you`, { cookie: owner.cookie });
  assert.deepEqual(inbox.data.requests.map(x => x.request.id), [first.data.id]);
  assert.equal(inbox.data.requests[0].project.id, feature.id);
  assert.deepEqual(inbox.data.reviews, []);
  assert.deepEqual(inbox.data.completed, []);
  assert.deepEqual((await request(`/api/projects/${privateRoot.id}/needs-you`, { cookie: owner.cookie })).data.requests.map(x => x.request.id), [privateRequest.data.id]);
  assert.equal((await request(`/api/jobs/${job.id}/move`, { method: 'POST', token: agent.data.token, json: { status: 'review', comment: 'Draft ready.' } })).status, 409);
  assert.equal((await request(`/api/jobs/${job.id}/requests/${first.data.id}/respond`, { method: 'POST', token: agent.data.token, json: { response: 'Use the short flow.' } })).status, 403);
  assert.equal((await request(`/api/jobs/${job.id}/requests/${first.data.id}/respond`, { method: 'POST', cookie: otherOwner.cookie, json: { response: 'Intrusion' } })).status, 404);
  assert.equal((await request(`/api/jobs/${unrelated.id}/requests/${first.data.id}/respond`, { method: 'POST', cookie: owner.cookie, json: { response: 'Wrong job' } })).status, 404);
  const answer = await request(`/api/jobs/${job.id}/requests/${first.data.id}/respond`, { method: 'POST', cookie: owner.cookie, json: { response: 'Use the short flow.' } });
  assert.equal(answer.status, 200);
  assert.equal(answer.data.status, 'answered');
  assert.equal((await request(`/api/jobs/${job.id}/requests/${first.data.id}/respond`, { method: 'POST', cookie: owner.cookie, json: { response: 'Again' } })).status, 409);
  const detail = await request(`/api/jobs/${job.id}`, { token: agent.data.token });
  assert.equal(detail.data.requests[0].response, 'Use the short flow.');
  assert.equal(detail.data.requests[0].respondedBy.id, owner.data.user.id);
  assert.equal(detail.data.comments.length, 1);
  assert.deepEqual((await request(`/api/projects/${root.id}/needs-you`, { cookie: owner.cookie })).data.requests, []);

  const review = await request(`/api/jobs/${job.id}/move`, { method: 'POST', token: agent.data.token, json: { status: 'review', comment: 'Short onboarding flow built and checked.' } });
  assert.equal(review.status, 200);
  assert.equal(review.data.submission.summary, 'Short onboarding flow built and checked.');
  assert.equal((await request(`/api/projects/${root.id}/needs-you`, { cookie: owner.cookie })).data.reviews[0].job.id, job.id);
  assert.equal((await request(`/api/jobs/${job.id}/move`, { method: 'POST', token: privateAgent.data.token, json: { status: 'completed', comment: 'Not my branch.' } })).status, 404);
  assert.equal((await request(`/api/jobs/${job.id}/move`, { method: 'POST', token: agent.data.token, json: { status: 'working', comment: 'Self review.' } })).status, 403);
  assert.equal((await request(`/api/jobs/${job.id}/move`, { method: 'POST', cookie: owner.cookie, json: { status: 'working' } })).status, 400);
  const changes = await request(`/api/jobs/${job.id}/move`, { method: 'POST', cookie: owner.cookie, json: { status: 'working', comment: 'Add the alternate path note.' } });
  assert.equal(changes.data.reviewDecision.outcome, 'changes_requested');
  assert.equal((await request(`/api/jobs/${job.id}`, { token: agent.data.token })).data.reviewDecision.note, 'Add the alternate path note.');
  await request(`/api/jobs/${job.id}/move`, { method: 'POST', token: agent.data.token, json: { status: 'review', comment: 'Added the alternate path note.' } });
  const approval = await request(`/api/jobs/${job.id}/move`, { method: 'POST', cookie: owner.cookie, json: { status: 'completed', comment: 'Verified both paths.' } });
  assert.equal(approval.data.reviewDecision.outcome, 'approved');
  const completeInbox = await request(`/api/projects/${root.id}/needs-you`, { cookie: owner.cookie });
  assert.deepEqual(completeInbox.data.reviews, []);
  assert.equal(completeInbox.data.completed[0].job.submission.summary, 'Added the alternate path note.');
  assert.equal(completeInbox.data.completed[0].job.reviewDecision.note, 'Verified both paths.');
});

test('review approval checks the submitter and clears stale decisions on each review', async t => {
  const request = await harness(t);
  const owner = await request('/api/auth/register', { method: 'POST', json: { name: 'Review Owner', email: 'independent-review@example.com', password: 'long-password-123', workspaceName: 'Studio' } });
  const workspaceId = owner.data.workspaces[0].id;
  const root = (await request(`/api/workspaces/${workspaceId}/projects`, { method: 'POST', cookie: owner.cookie, json: { name: 'Product' } })).data;
  const agent = await request(`/api/workspaces/${workspaceId}/agents`, { method: 'POST', cookie: owner.cookie, json: { name: 'builder-agent', rootProjectId: root.id } });
  const job = (await request(`/api/projects/${root.id}/jobs`, { method: 'POST', cookie: owner.cookie, json: { title: 'Build the feature' } })).data;
  const move = (auth, status, comment) => request(`/api/jobs/${job.id}/move`, { method: 'POST', ...auth, json: { status, comment } });
  await request(`/api/jobs/${job.id}/claim`, { method: 'POST', token: agent.data.token });

  const ownerSubmission = await move({ cookie: owner.cookie }, 'review', 'Owner sent the agent work for review.');
  assert.equal(ownerSubmission.status, 200);
  assert.equal(ownerSubmission.data.submission.submittedBy.id, owner.data.user.id);
  assert.equal((await move({ cookie: owner.cookie }, 'completed', 'I approve my own submission.')).status, 403);
  assert.equal((await request(`/api/jobs/${job.id}`, { token: agent.data.token })).data.status, 'review');
  const changes = await move({ cookie: owner.cookie }, 'working', 'Agent should submit the final result.');
  assert.equal(changes.data.reviewDecision.outcome, 'changes_requested');

  const agentSubmission = await move({ token: agent.data.token }, 'review', 'Agent checked the final result.');
  assert.equal(agentSubmission.status, 200);
  assert.equal(agentSubmission.data.submission.submittedBy.id, agent.data.agent.id);
  assert.equal(agentSubmission.data.reviewDecision, undefined);
  assert.equal((await request(`/api/projects/${root.id}/needs-you`, { cookie: owner.cookie })).data.reviews[0].job.reviewDecision, undefined);
  const approved = await move({ cookie: owner.cookie }, 'completed', 'Owner verified the final result.');
  assert.equal(approved.status, 200);
  assert.equal(approved.data.reviewDecision.outcome, 'approved');

  const reopened = await move({ cookie: owner.cookie }, 'review', 'Recheck the completed result.');
  assert.equal(reopened.status, 200);
  assert.equal(reopened.data.submission.submittedBy.id, agent.data.agent.id);
  assert.equal(reopened.data.reviewDecision, undefined);
  assert.equal((await request(`/api/projects/${root.id}/needs-you`, { cookie: owner.cookie })).data.reviews[0].job.reviewDecision, undefined);
  assert.equal((await move({ cookie: owner.cookie }, 'completed', 'Recheck passed.')).status, 200);
  const detail = await request(`/api/jobs/${job.id}`, { token: agent.data.token });
  assert.ok(detail.data.comments.some(comment => comment.body === 'Owner verified the final result.'));
  assert.ok(detail.data.comments.some(comment => comment.body === 'Recheck the completed result.'));
});

test('returning a job to Ideas cancels its pending request and allows a fresh claim', async t => {
  const request = await harness(t);
  const owner = await request('/api/auth/register', { method: 'POST', json: { name: 'Decision Owner', email: 'cancel-request@example.com', password: 'long-password-123', workspaceName: 'Studio' } });
  const workspaceId = owner.data.workspaces[0].id;
  const root = (await request(`/api/workspaces/${workspaceId}/projects`, { method: 'POST', cookie: owner.cookie, json: { name: 'Product' } })).data;
  const agent = await request(`/api/workspaces/${workspaceId}/agents`, { method: 'POST', cookie: owner.cookie, json: { name: 'builder-agent', rootProjectId: root.id } });
  const job = (await request(`/api/projects/${root.id}/jobs`, { method: 'POST', cookie: owner.cookie, json: { title: 'Choose a path' } })).data;
  await request(`/api/jobs/${job.id}/claim`, { method: 'POST', token: agent.data.token });
  const first = await request(`/api/jobs/${job.id}/requests`, { method: 'POST', token: agent.data.token, json: { kind: 'question', question: 'Which path?', context: 'Two options remain.' } });
  assert.equal(first.status, 201);
  assert.equal((await request(`/api/projects/${root.id}/needs-you`, { cookie: owner.cookie })).data.requests.length, 1);

  const returned = await request(`/api/jobs/${job.id}/move`, { method: 'POST', cookie: owner.cookie, json: { status: 'idea', comment: 'Reprioritize this later.' } });
  assert.equal(returned.status, 200);
  assert.equal(returned.data.assignee, null);
  const cancelled = (await request(`/api/jobs/${job.id}`, { token: agent.data.token })).data.requests[0];
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancellationReason, 'Reprioritize this later.');
  assert.equal(cancelled.cancelledBy.id, owner.data.user.id);
  assert.deepEqual((await request(`/api/projects/${root.id}/needs-you`, { cookie: owner.cookie })).data.requests, []);
  assert.equal((await request(`/api/jobs/${job.id}/requests/${first.data.id}/respond`, { method: 'POST', cookie: owner.cookie, json: { response: 'Old answer' } })).status, 409);

  assert.equal((await request(`/api/jobs/${job.id}/claim`, { method: 'POST', token: agent.data.token })).status, 200);
  const second = await request(`/api/jobs/${job.id}/requests`, { method: 'POST', token: agent.data.token, json: { kind: 'blocker', question: 'What now?', context: 'Work has resumed.' } });
  assert.equal(second.status, 201);
  assert.notEqual(second.data.id, first.data.id);
  assert.deepEqual((await request(`/api/projects/${root.id}/needs-you`, { cookie: owner.cookie })).data.requests.map(item => item.request.id), [second.data.id]);
  const detail = await request(`/api/jobs/${job.id}`, { token: agent.data.token });
  assert.deepEqual(detail.data.requests.map(item => item.status), ['cancelled', 'pending']);
});

test('project briefs have legacy defaults and only the owner can edit them', async t => {
  const request = await harness(t);
  const owner = await request('/api/auth/register', { method: 'POST', json: { name: 'Brief Owner', email: 'brief-owner@example.com', password: 'long-password-123', workspaceName: 'Studio' } });
  const other = await request('/api/auth/register', { method: 'POST', json: { name: 'Other Owner', email: 'brief-other@example.com', password: 'long-password-456', workspaceName: 'Other' } });
  const workspaceId = owner.data.workspaces[0].id;
  const created = await request(`/api/workspaces/${workspaceId}/projects`, { method: 'POST', cookie: owner.cookie, json: { name: 'Product' } });
  const projectId = created.data.id;
  const empty = { purpose: '', workContext: '', constraints: '', definitionOfDone: '' };
  assert.deepEqual((await request(`/api/projects/${projectId}`, { cookie: owner.cookie })).data.brief, empty);
  const saved = JSON.parse(await readFile(join(request.folder, 'board.json'), 'utf8'));
  delete saved.projects[0].brief;
  await writeFile(join(request.folder, 'board.json'), JSON.stringify(saved));
  assert.deepEqual((await request(`/api/projects/${projectId}`, { cookie: owner.cookie })).data.brief, empty);

  const agent = await request(`/api/workspaces/${workspaceId}/agents`, { method: 'POST', cookie: owner.cookie, json: { name: 'brief-agent', rootProjectId: projectId } });
  const brief = { purpose: 'Ship an accessible first release', workContext: 'Local prototype folder', constraints: 'Do not read secrets or alter permissions', definitionOfDone: 'Owner reviews the running flow' };
  const endpoint = `/api/projects/${projectId}/brief`;
  assert.equal((await request(endpoint, { method: 'PATCH', token: agent.data.token, json: brief })).status, 403);
  assert.equal((await request(endpoint, { method: 'PATCH', cookie: other.cookie, json: brief })).status, 404);
  assert.equal((await request(endpoint, { method: 'PATCH', cookie: owner.cookie, json: { ...brief, constraints: 123 } })).status, 400);
  assert.equal((await request(endpoint, { method: 'PATCH', cookie: owner.cookie, json: { ...brief, purpose: 'x'.repeat(4001) } })).status, 400);
  const updated = await request(endpoint, { method: 'PATCH', cookie: owner.cookie, json: brief });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.data.brief, brief);
  assert.deepEqual((await request(`/api/projects/${projectId}`, { token: agent.data.token })).data.brief, brief);
  assert.deepEqual((await request(`/api/workspaces/${workspaceId}/projects`, { token: agent.data.token })).data[0].brief, brief);
  assert.equal((await request(`/api/projects/${projectId}/activity`, { cookie: owner.cookie })).data.some(item => item.action === 'project.brief_updated'), true);
});

test('revoking an agent while its write waits prevents the queued change', async t => {
  let pauseNextWrite = false;
  let releaseWrite;
  let writeStarted;
  const started = new Promise(resolve => { writeStarted = resolve; });
  const request = await harness(t, filePath => {
    const base = createStore(filePath);
    return {
      read: fn => base.read(fn),
      write: fn => {
        if (!pauseNextWrite) return base.write(fn);
        pauseNextWrite = false;
        writeStarted();
        return new Promise(resolve => { releaseWrite = resolve; }).then(() => base.write(fn));
      },
    };
  });
  const owner = await request('/api/auth/register', { method: 'POST', json: { name: 'Owner', email: 'race@example.com', password: 'long-password-123' } });
  const workspaceId = owner.data.workspaces[0].id;
  const project = await request(`/api/workspaces/${workspaceId}/projects`, { method: 'POST', cookie: owner.cookie, json: { name: 'Race test' } });
  const agent = await request(`/api/workspaces/${workspaceId}/agents`, { method: 'POST', cookie: owner.cookie, json: { name: 'race-agent', rootProjectId: project.data.id } });
  const job = await request(`/api/projects/${project.data.id}/jobs`, { method: 'POST', cookie: owner.cookie, json: { title: 'Write test' } });
  pauseNextWrite = true;
  const pending = request(`/api/jobs/${job.data.id}/comments`, { method: 'POST', token: agent.data.token, json: { body: 'Should be rejected' } });
  await started;
  assert.equal((await request(`/api/workspaces/${workspaceId}/agents/${agent.data.agent.id}`, { method: 'DELETE', cookie: owner.cookie })).status, 200);
  releaseWrite();
  assert.equal((await pending).status, 401);
  assert.equal((await request(`/api/jobs/${job.data.id}`, { cookie: owner.cookie })).data.comments.length, 0);
});
