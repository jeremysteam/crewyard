import assert from 'node:assert/strict';
import test from 'node:test';
import postgres from 'postgres';
import { createPostgresStore } from './postgres-store.mjs';

const connectionString = process.env.CREWYARD_TEST_DATABASE_URL;
const integration = connectionString ? test : test.skip;
const when = () => new Date().toISOString();
const owner = { type: 'user', id: 'adapter-owner', name: 'Owner', handle: 'owner' };
const agent = { type: 'agent', id: 'adapter-agent', name: 'Agent', handle: 'agent' };

integration('relational adapter preserves claims, invites, histories, and indexed reads', async () => {
  const store = createPostgresStore(connectionString);
  await store.health();
  await store.write(db => {
    db.users.push({ id: owner.id, name: owner.name, handle: owner.handle, email: 'adapter@example.test', passwordHash: 'test',
      createdAt: when() });
    db.sessions.push({ tokenHash: 'adapter-session-hash', userId: owner.id, expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    db.workspaces.push({ id: 'adapter-space', name: 'Space', ownerId: owner.id, createdAt: when() });
    db.projects.push({ id: 'adapter-project', workspaceId: 'adapter-space', parentProjectId: null, name: 'Project',
      description: '', brief: { purpose: 'Test' }, scopePlan: '', reviewInstructions: '', workLocations: [], createdBy: owner, createdAt: when() });
    db.agentInvites.push({ id: 'adapter-invite', workspaceId: 'adapter-space', rootProjectId: 'adapter-project',
      secretHash: 'adapter-secret-hash', createdBy: owner, createdAt: when(), expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      maxUses: 1, useCount: 0, revokedAt: null, redemptions: [] });
    db.agents.push({ id: agent.id, workspaceId: 'adapter-space', rootProjectId: 'adapter-project', inviteId: null,
      name: agent.name, tokenHash: 'adapter-agent-hash', canReview: false, createdAt: when(), revokedAt: null });
    db.jobs.push({ id: 'adapter-job', projectId: 'adapter-project', goalId: null, title: 'Job', body: '',
      startingPoint: { branch: '' }, status: 'idea', assignee: null, createdBy: owner, createdAt: when(), updatedAt: when() });
  });
  assert.equal((await store.resolveActor({ agentTokenHash: 'adapter-agent-hash' })).id, agent.id);
  assert.equal((await store.resolveActor({ sessionTokenHash: 'adapter-session-hash' })).id, owner.id);

  const claim = async name => store.write(db => {
    const job = db.jobs.find(item => item.id === 'adapter-job');
    if (job.assignee) throw new Error('already claimed');
    const claimant = { ...agent, name, handle: name };
    const run = { id: 'adapter-run-' + name, directions: { branch: '' }, startingPoint: null, startedBy: claimant, startedAt: when() };
    job.assignee = claimant; job.status = 'working'; job.run = run; job.runs = [run]; job.updatedAt = when();
  });
  const claims = await Promise.allSettled([claim('agent-a'), claim('agent-b')]);
  assert.equal(claims.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(claims.filter(item => item.status === 'rejected').length, 1);

  const redeem = async suffix => store.write(db => {
    const invite = db.agentInvites.find(item => item.id === 'adapter-invite');
    if (invite.useCount >= invite.maxUses) throw new Error('invite exhausted');
    const id = 'adapter-new-' + suffix;
    db.agents.push({ id, workspaceId: 'adapter-space', rootProjectId: 'adapter-project', inviteId: invite.id,
      name: id, tokenHash: id + '-hash', canReview: false, createdAt: when(), revokedAt: null });
    invite.useCount++;
    invite.redemptions.push({ agentId: id, name: id, createdAt: when() });
  });
  const redemptions = await Promise.allSettled([redeem('a'), redeem('b')]);
  assert.equal(redemptions.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(redemptions.filter(item => item.status === 'rejected').length, 1);

  await store.write(db => {
    const job = db.jobs.find(item => item.id === 'adapter-job');
    const submission = { id: 'adapter-submission', summary: 'Ready', submittedBy: job.assignee, submittedAt: when(),
      run: job.run, reviewEvidence: { artifacts: [], checks: [], notes: '' } };
    job.submission = submission; job.submissionHistory = [submission]; job.status = 'review'; job.updatedAt = when();
    db.comments.push({ id: 'adapter-comment', projectId: 'adapter-project', goalId: null, jobId: job.id,
      author: job.assignee, body: 'Ready @owner', createdAt: when() });
    db.mentions.push({ id: 'adapter-mention', recipientType: 'user', recipientId: owner.id, commentId: 'adapter-comment',
      projectId: 'adapter-project', goalId: null, jobId: job.id, from: job.assignee, readAt: null, createdAt: when() });
    db.activity.push({ id: db.nextActivityId++, projectId: 'adapter-project', goalId: null, jobId: job.id,
      actor: job.assignee, action: 'job.submitted', detail: 'Ready', createdAt: when() });
  });
  const detail = await store.read(db => db.jobs.find(item => item.id === 'adapter-job'), { commentJobId: 'adapter-job' });
  assert.equal(detail.run.id.startsWith('adapter-run-'), true);
  assert.equal(detail.submission.run.id, detail.run.id);
  assert.equal((await store.read(db => db.comments.length, { commentJobId: 'adapter-job' })), 1);
  assert.equal((await store.read(db => db.comments.length, { omitHeavy: true })), 0);
  const inbox = await store.listMentions({ actor: { kind: 'user', id: owner.id }, sessionTokenHash: 'adapter-session-hash' });
  assert.equal(inbox.unread, 1);
  await store.markMentionsRead({ actor: { kind: 'user', id: owner.id }, sessionTokenHash: 'adapter-session-hash',
    ids: new Set(['adapter-mention']) });
  assert.equal((await store.listMentions({ actor: { kind: 'user', id: owner.id }, sessionTokenHash: 'adapter-session-hash' })).unread, 0);
  const activity = await store.listActivity({ actor: { kind: 'user', id: owner.id }, sessionTokenHash: 'adapter-session-hash',
    projectId: 'adapter-project', since: 0 });
  assert.equal(activity.length, 1);
  await assert.rejects(store.listActivity({ actor: { kind: 'user', id: owner.id }, sessionTokenHash: 'wrong',
    projectId: 'adapter-project', since: 0 }), error => error.status === 401);
  await store.write(db => { db.agents.find(item => item.id === agent.id).revokedAt = when(); });
  await assert.rejects(store.listMentions({ actor: { kind: 'agent', id: agent.id, rootProjectId: 'adapter-project' },
    agentTokenHash: 'adapter-agent-hash' }), error => error.status === 401);
  await store.close();
});

integration('routine scoped read and append with 4,000 existing comments', async () => {
  const admin = postgres(connectionString, { prepare: false, ssl: false });
  await admin`INSERT INTO board_private.comments(id,project_id,goal_id,job_id,author_type,author_id,author_name,author_handle,body,created_at)
    SELECT 'adapter-bulk-' || g, 'adapter-project', NULL, 'adapter-job', 'user', 'adapter-owner', 'Owner', 'owner', 'bulk', now()
    FROM generate_series(1,4000) g ON CONFLICT (id) DO NOTHING`;
  await admin.end();
  const store = createPostgresStore(connectionString);
  const readStarted = performance.now();
  assert.equal(await store.read(db => db.jobs.some(item => item.id === 'adapter-job'), { omitHeavy: true }), true);
  const readMs = performance.now() - readStarted;
  const writeStarted = performance.now();
  await store.write(db => db.comments.push({ id: 'adapter-after-bulk', projectId: 'adapter-project', goalId: null,
    jobId: 'adapter-job', author: owner, body: 'After bulk', createdAt: when() }));
  const writeMs = performance.now() - writeStarted;
  const scopedCount = await store.read(db => db.comments.length, { commentJobId: 'adapter-job' });
  assert.equal(scopedCount, 4002);
  console.log('4k comment fixture: scoped read', readMs.toFixed(1), 'ms; one-row append', writeMs.toFixed(1), 'ms');
  await store.close();
});
