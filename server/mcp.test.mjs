import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createApp } from './app.mjs';

async function harness(t) {
  const folder = await mkdtemp(join(tmpdir(), 'common-ground-mcp-'));
  const server = createApp({ filePath: join(folder, 'board.json') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(folder, { recursive: true, force: true }); });
  async function api(path, { method = 'GET', cookie, json } = {}) {
    const result = await fetch(url + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(json ? { 'content-type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : undefined });
    return { status: result.status, cookie: result.headers.get('set-cookie')?.split(';')[0], data: await result.json() };
  }
  async function connect(token) {
    const client = new Client({ name: 'commonground-test', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: ['server/mcp.mjs'], cwd: process.cwd(), env: { ...process.env, COMMON_GROUND_TOKEN: token, COMMON_GROUND_URL: url }, stderr: 'pipe' });
    await client.connect(transport);
    t.after(() => client.close());
    return client;
  }
  return { api, connect };
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content[0]?.text || '';
  return { error: !!result.isError, data: result.isError ? content : JSON.parse(content) };
}

test('MCP agent can create one-level feature projects and goals only in its assigned branch', async t => {
  const { api, connect } = await harness(t);
  const owner = await api('/api/auth/register', { method: 'POST', json: { name: 'Planning Owner', email: 'planning-mcp@example.com', password: 'long-password-123', workspaceName: 'Studio' } });
  const workspaceId = owner.data.workspaces[0].id;
  const createProject = (name, parentProjectId) => api(`/api/workspaces/${workspaceId}/projects`, { method: 'POST', cookie: owner.cookie, json: { name, parentProjectId } });
  const root = (await createProject('Product')).data;
  const other = (await createProject('Private product')).data;
  const agent = (await api(`/api/workspaces/${workspaceId}/agents`, { method: 'POST', cookie: owner.cookie, json: { name: 'planner', rootProjectId: root.id } })).data;
  const client = await connect(agent.token);
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(names.includes('create_feature_project'));
  assert.ok(names.includes('create_goal'));

  const feature = await call(client, 'create_feature_project', { parentProjectId: root.id, name: ' Onboarding ', description: 'First-run flow' });
  assert.equal(feature.error, false);
  assert.equal(feature.data.parentProjectId, root.id);
  assert.equal(feature.data.name, 'Onboarding');
  assert.equal(feature.data.createdBy.id, agent.agent.id);
  assert.ok((await call(client, 'list_projects')).data.some(project => project.id === feature.data.id));

  for (const projectId of [root.id, feature.data.id]) {
    const created = await call(client, 'create_goal', { projectId, title: ' Deliver first run ', description: 'Complete the onboarding path' });
    assert.equal(created.error, false);
    assert.equal(created.data.projectId, projectId);
    assert.equal(created.data.title, 'Deliver first run');
    assert.equal(created.data.createdBy.id, agent.agent.id);
    assert.ok((await call(client, 'list_goals', { projectId })).data.some(goal => goal.id === created.data.id));
  }
  const longDescription = await call(client, 'create_goal', { projectId: root.id, title: 'Long plan', description: 'x'.repeat(10_010) });
  assert.equal(longDescription.error, false);
  assert.equal(longDescription.data.description.length, 10_000);

  assert.match((await call(client, 'create_feature_project', { parentProjectId: other.id, name: 'Intrusion' })).data, /403/);
  assert.match((await call(client, 'create_feature_project', { parentProjectId: feature.data.id, name: 'Too deep' })).data, /403/);
  assert.match((await call(client, 'create_goal', { projectId: other.id, title: 'Intrusion' })).data, /404/);
  assert.equal((await call(client, 'create_feature_project', { parentProjectId: root.id, name: ' ' })).error, true);
  assert.equal((await call(client, 'create_goal', { projectId: root.id, title: ' ' })).error, true);
  assert.deepEqual((await call(client, 'list_projects')).data.map(project => project.id).sort(), [root.id, feature.data.id].sort());
  assert.deepEqual((await call(client, 'list_goals', { projectId: other.id })).error, true);
  await api(`/api/workspaces/${workspaceId}/agents/${agent.agent.id}`, { method: 'DELETE', cookie: owner.cookie });
  assert.match((await call(client, 'create_feature_project', { parentProjectId: root.id, name: 'After revocation' })).data, /401/);
  assert.match((await call(client, 'create_goal', { projectId: root.id, title: 'After revocation' })).data, /401/);
});

test('MCP job tools preserve starting directions, claim provenance, and review evidence', async t => {
  const { api, connect } = await harness(t);
  const owner = await api('/api/auth/register', { method: 'POST', json: { name: 'Evidence Owner', email: 'evidence-mcp@example.com', password: 'long-password-123', workspaceName: 'Studio' } });
  const workspaceId = owner.data.workspaces[0].id;
  const root = (await api(`/api/workspaces/${workspaceId}/projects`, { method: 'POST', cookie: owner.cookie, json: { name: 'Product' } })).data;
  const agent = (await api(`/api/workspaces/${workspaceId}/agents`, { method: 'POST', cookie: owner.cookie, json: { name: 'builder', rootProjectId: root.id } })).data;
  const client = await connect(agent.token);
  const created = await call(client, 'create_job', { projectId: root.id, title: 'Build onboarding', startingPoint: { branch: 'main', commit: 'abc123' } });
  assert.equal(created.error, false);
  assert.deepEqual(created.data.startingPoint, { branch: 'main', commit: 'abc123', worktree: '' });
  const jobId = created.data.id;
  const updated = await call(client, 'update_job', { jobId, startingPoint: { branch: 'release', commit: 'def456', worktree: 'E:\\work\\onboarding' } });
  assert.equal(updated.error, false);
  assert.equal(updated.data.startingPoint.branch, 'release');
  const claimed = await call(client, 'claim_job', { jobId, startingPoint: { branch: 'agent/onboarding', commit: 'fedcba' } });
  assert.equal(claimed.error, false);
  assert.equal(claimed.data.run.directions.branch, 'release');
  assert.equal(claimed.data.run.startingPoint.branch, 'agent/onboarding');
  assert.equal((await call(client, 'update_job', { jobId, startingPoint: { branch: 'too-late' } })).error, true);

  const evidence = { artifacts: [{ label: 'Patch', target: 'https://example.test/review/1' }], checks: [{ name: 'npm test', result: 'passed', detail: 'All tests passed' }], notes: 'Verified the first-run flow.' };
  const submitted = await call(client, 'submit_for_review', { jobId, comment: 'Onboarding is ready for review.', reviewEvidence: evidence });
  assert.equal(submitted.error, false);
  assert.equal(submitted.data.submission.summary, 'Onboarding is ready for review.');
  assert.deepEqual(submitted.data.submission.reviewEvidence, evidence);
  assert.equal(submitted.data.submission.run.id, claimed.data.run.id);
  const read = await call(client, 'get_job', { jobId });
  assert.equal(read.data.submissionHistory.length, 1);
  assert.equal(read.data.submissionHistory[0].id, submitted.data.submission.id);
  assert.equal(read.data.run.directions.commit, 'def456');
  assert.equal((await call(client, 'submit_for_review', { jobId, comment: 'Repeat', reviewEvidence: evidence })).error, true);
});

test('MCP manager agent can propose scope and read its owner decision', async t => {
  const { api, connect } = await harness(t);
  const owner = await api('/api/auth/register', { method: 'POST', json: { name: 'Scope Owner', email: 'scope-mcp@example.com', password: 'long-password-123', workspaceName: 'Studio' } });
  const workspaceId = owner.data.workspaces[0].id;
  const root = (await api(`/api/workspaces/${workspaceId}/projects`, { method: 'POST', cookie: owner.cookie, json: { name: 'Video generator' } })).data;
  const other = (await api(`/api/workspaces/${workspaceId}/projects`, { method: 'POST', cookie: owner.cookie, json: { name: 'Other product' } })).data;
  const agent = await api(`/api/workspaces/${workspaceId}/agents`, { method: 'POST', cookie: owner.cookie, json: { name: 'scope-manager', rootProjectId: root.id } });
  const client = await connect(agent.data.token);
  const brief = { purpose: 'Make music videos', workContext: 'Browser prototype', constraints: 'No production access', definitionOfDone: 'Pilot works' };
  const wrong = await call(client, 'propose_project_scope', { projectId: other.id, brief, plan: 'Make a song map' });
  assert.equal(wrong.error, true);
  const proposed = await call(client, 'propose_project_scope', { projectId: root.id, brief, plan: 'Make a song map' });
  assert.equal(proposed.error, false);
  assert.equal(proposed.data.status, 'pending');
  assert.equal((await call(client, 'list_project_scope_proposals', { projectId: root.id })).data.length, 1);
  await api(`/api/projects/${root.id}/scope-proposals/${proposed.data.id}/decision`, { method: 'POST', cookie: owner.cookie, json: { decision: 'approve' } });
  const read = await call(client, 'get_project_scope_proposal', { projectId: root.id, proposalId: proposed.data.id });
  assert.equal(read.data.status, 'approved');
  assert.equal((await call(client, 'get_project', { projectId: root.id })).data.brief.purpose, brief.purpose);
});

test('MCP exposes only board tools and enforces top-level project isolation', async t => {
  const { api, connect } = await harness(t);
  const owner = await api('/api/auth/register', { method: 'POST', json: { name: 'Board Owner', email: 'owner-mcp@example.com', password: 'long-password-123', workspaceName: 'Studio' } });
  const otherOwner = await api('/api/auth/register', { method: 'POST', json: { name: 'Other Owner', email: 'other-mcp@example.com', password: 'long-password-456', workspaceName: 'Other' } });
  const workspaceId = owner.data.workspaces[0].id;
  const project = (name, parentProjectId, cookie = owner.cookie, id = workspaceId) => api(`/api/workspaces/${id}/projects`, { method: 'POST', cookie, json: { name, parentProjectId } });
  const ownRoot = (await project('CommonGround')).data;
  const ownFeature = (await project('MCP interface', ownRoot.id)).data;
  const privateRoot = (await project('AI Creator U')).data;
  const privateFeature = (await project('Music', privateRoot.id)).data;
  const remoteRoot = (await project('Other workspace', null, otherOwner.cookie, otherOwner.data.workspaces[0].id)).data;
  const invite = await api(`/api/projects/${ownRoot.id}/agent-invites`, { method: 'POST', cookie: owner.cookie, json: {} });
  assert.equal(invite.status, 201);
  const agent = await api('/api/agent-enrollments', { method: 'POST', json: { invite: invite.data.secret, name: 'board-agent' } });
  assert.equal(agent.status, 201);
  const client = await connect(agent.data.token);
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(names.includes('submit_for_review'));
  assert.ok(names.includes('get_assignment'));
  assert.ok(names.every(name => !/file|shell|command|fetch_url|http_request/.test(name)));
  assert.deepEqual((await client.listResources()).resources, []);

  const assignment = (await call(client, 'get_assignment')).data;
  assert.equal(assignment.project.id, ownRoot.id);
  assert.deepEqual(assignment.project.childProjects.map(p => p.id), [ownFeature.id]);
  const listed = (await call(client, 'list_projects')).data;
  assert.deepEqual(new Set(listed.map(p => p.id)), new Set([ownRoot.id, ownFeature.id]));
  for (const projectId of [privateRoot.id, privateFeature.id, remoteRoot.id]) {
    for (const tool of ['get_project', 'list_goals', 'list_jobs', 'get_activity']) {
      const result = await call(client, tool, { projectId });
      assert.equal(result.error, true, `${tool} must reject another branch`);
      assert.match(result.data, /404/);
    }
    assert.equal((await call(client, 'create_job', { projectId, title: 'Intrusion' })).error, true);
  }
  const goal = await api(`/api/projects/${privateFeature.id}/goals`, { method: 'POST', cookie: owner.cookie, json: { title: 'Private goal' } });
  const job = await api(`/api/projects/${privateFeature.id}/jobs`, { method: 'POST', cookie: owner.cookie, json: { title: 'Private job' } });
  assert.equal((await call(client, 'get_goal', { goalId: goal.data.id })).error, true);
  for (const tool of ['get_job', 'claim_job', 'submit_for_review']) {
    const result = await call(client, tool, { jobId: job.data.id, comment: 'Trying to cross branches' });
    assert.equal(result.error, true);
    assert.match(result.data, /404/);
  }
  assert.equal((await call(client, 'comment_on_job', { jobId: job.data.id, body: 'Intrusion' })).error, true);
  assert.equal((await call(client, 'vote_on_job', { jobId: job.data.id, value: 1, reason: 'Intrusion' })).error, true);
  await api(`/api/jobs/${job.data.id}/comments`, { method: 'POST', cookie: owner.cookie, json: { body: '@board-agent private mention' } });
  assert.equal((await call(client, 'get_mentions')).data.unread, 0);
});

test('MCP job workflow uses current token authorization and honors revocation', async t => {
  const { api, connect } = await harness(t);
  const owner = await api('/api/auth/register', { method: 'POST', json: { name: 'Review Owner', email: 'review-mcp@example.com', password: 'long-password-123', workspaceName: 'Review' } });
  const workspaceId = owner.data.workspaces[0].id;
  const root = await api(`/api/workspaces/${workspaceId}/projects`, { method: 'POST', cookie: owner.cookie, json: { name: 'Product' } });
  const feature = await api(`/api/workspaces/${workspaceId}/projects`, { method: 'POST', cookie: owner.cookie, json: { name: 'Onboarding', parentProjectId: root.data.id } });
  await api(`/api/projects/${root.data.id}/work-locations`, { method: 'POST', cookie: owner.cookie, json: { label: 'Main repo', kind: 'folder', target: 'C:\\work\\product' } });
  const goal = await api(`/api/projects/${feature.data.id}/goals`, { method: 'POST', cookie: owner.cookie, json: { title: 'First run' } });
  const agent = await api(`/api/workspaces/${workspaceId}/agents`, { method: 'POST', cookie: owner.cookie, json: { name: 'builder-agent', rootProjectId: root.data.id } });
  const client = await connect(agent.data.token);
  assert.deepEqual((await call(client, 'list_goals', { projectId: feature.data.id })).data.map(g => g.id), [goal.data.id]);
  const created = await call(client, 'create_job', { projectId: feature.data.id, goalId: goal.data.id, title: 'Build setup', body: 'Follow the project requirements.' });
  assert.equal(created.error, false);
  const jobId = created.data.id;
  const directions = (await call(client, 'get_job', { jobId })).data.workLocations;
  assert.equal(directions[0].target, 'C:\\work\\product');
  assert.equal(directions[0].inherited, true);
  assert.equal((await call(client, 'claim_job', { jobId })).data.status, 'working');
  assert.equal((await call(client, 'claim_job', { jobId })).error, true);
  const decision = await call(client, 'request_decision', { jobId, kind: 'question', question: 'Which setup path should lead?', context: 'Two options are ready.', recommendation: 'Lead with the shorter path.' });
  assert.equal(decision.error, false);
  assert.equal((await call(client, 'request_decision', { jobId, kind: 'blocker', question: 'Another question', context: 'Still waiting.' })).error, true);
  assert.equal((await api(`/api/jobs/${jobId}/requests/${decision.data.id}/respond`, { method: 'POST', cookie: owner.cookie, json: { response: 'Use the shorter path.' } })).status, 200);
  assert.equal((await call(client, 'get_job', { jobId })).data.requests[0].response, 'Use the shorter path.');
  assert.equal((await call(client, 'update_job', { jobId, body: 'Document the completed setup.' })).data.body, 'Document the completed setup.');
  assert.equal((await call(client, 'comment_on_goal', { goalId: goal.data.id, body: 'Work is underway.' })).error, false);
  assert.equal((await call(client, 'comment_on_job', { jobId, body: '@review-owner Ready for a check soon.' })).error, false);
  assert.equal((await call(client, 'vote_on_job', { jobId, value: 1, reason: 'Useful first run' })).error, false);
  assert.equal((await call(client, 'submit_for_review', { jobId, comment: 'Verified with the onboarding tests.' })).data.status, 'review');
  assert.equal((await call(client, 'move_job', { jobId, status: 'completed', comment: 'Self approval' })).error, true);
  const detail = (await call(client, 'get_job', { jobId })).data;
  assert.equal(detail.comments.length, 2);
  assert.equal(detail.votes.length, 1);
  const activity = (await call(client, 'get_activity', { projectId: root.data.id })).data;
  assert.ok(activity.some(item => item.jobId === jobId && item.action === 'job.moved'));
  await api(`/api/jobs/${jobId}/comments`, { method: 'POST', cookie: owner.cookie, json: { body: '@builder-agent Please add one screenshot.' } });
  const inbox = (await call(client, 'get_mentions')).data;
  assert.equal(inbox.unread, 1);
  assert.equal((await call(client, 'mark_mentions_read', { ids: [inbox.mentions[0].id] })).error, false);
  assert.equal((await call(client, 'get_mentions')).data.unread, 0);
  await api(`/api/workspaces/${workspaceId}/agents/${agent.data.agent.id}`, { method: 'DELETE', cookie: owner.cookie });
  assert.match((await call(client, 'get_job', { jobId })).data, /401/);
  assert.equal((await call(client, 'get_assignment')).error, true);
});

test('MCP reviewer tools require owner assignment and an independent review note', async t => {
  const { api, connect } = await harness(t);
  const owner = await api('/api/auth/register', { method: 'POST', json: { name: 'Owner', email: 'mcp-reviewer@example.test', password: 'long-password-123', workspaceName: 'Studio' } });
  const workspaceId = owner.data.workspaces[0].id;
  const root = (await api(`/api/workspaces/${workspaceId}/projects`, { method: 'POST', cookie: owner.cookie, json: { name: 'Product' } })).data;
  const builder = (await api(`/api/workspaces/${workspaceId}/agents`, { method: 'POST', cookie: owner.cookie, json: { name: 'builder', rootProjectId: root.id } })).data;
  const reviewer = (await api(`/api/workspaces/${workspaceId}/agents`, { method: 'POST', cookie: owner.cookie, json: { name: 'reviewer', rootProjectId: root.id } })).data;
  const reviewerClient = await connect(reviewer.token);
  const builderClient = await connect(builder.token);
  const job = (await api(`/api/projects/${root.id}/jobs`, { method: 'POST', cookie: owner.cookie, json: { title: 'Build a feature' } })).data;
  assert.equal((await call(builderClient, 'claim_job', { jobId: job.id })).error, false);
  assert.equal((await call(builderClient, 'submit_for_review', { jobId: job.id, comment: 'Verified locally.' })).error, false);
  assert.equal((await call(reviewerClient, 'list_review_queue', { projectId: root.id })).error, true);
  assert.equal((await call(reviewerClient, 'review_job', { jobId: job.id, decision: 'approve', note: 'Checked.' })).error, true);
  assert.equal((await api(`/api/workspaces/${workspaceId}/agents/${reviewer.agent.id}/reviewer`, { method: 'PATCH', cookie: owner.cookie, json: { canReview: true } })).status, 200);
  assert.equal((await call(reviewerClient, 'get_assignment')).data.agent.canReview, true);
  assert.equal((await call(reviewerClient, 'list_review_queue', { projectId: root.id })).data[0].id, job.id);
  assert.equal((await call(reviewerClient, 'review_job', { jobId: job.id, decision: 'request_changes', note: 'Add a regression test.' })).data.status, 'working');
  assert.equal((await call(builderClient, 'submit_for_review', { jobId: job.id, comment: 'Regression test added.' })).data.status, 'review');
  assert.equal((await call(builderClient, 'review_job', { jobId: job.id, decision: 'approve', note: 'Self review.' })).error, true);
  assert.equal((await call(reviewerClient, 'review_job', { jobId: job.id, decision: 'approve', note: 'Regression test passes.' })).data.status, 'completed');
});
