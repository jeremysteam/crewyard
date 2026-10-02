import assert from 'node:assert/strict';
import test from 'node:test';
import { diffState, flattenState, hydrateState } from './postgres-store.mjs';

const actor = { type: 'agent', id: 'agent-1', name: 'Agent One', handle: 'agent-1' };
const owner = { type: 'user', id: 'user-1', name: 'Owner', handle: 'owner' };
const when = '2026-09-23T12:00:00.000Z';
const empty = () => ({
  users: [], authIdentities: [], sessions: [], workspaces: [], agents: [], agentInvites: [],
  projects: [], goals: [], jobs: [], jobRequests: [], scopeProposals: [],
  comments: [], votes: [], mentions: [], activity: [], folderPairings: [],
  folders: [], announcements: [], meetings: [], meetingRounds: [], meetingResponses: [], meetingVotes: [], meetingMemories: [], nextActivityId: 1,
});

function populated() {
  const state = empty();
  state.users.push({ id: 'user-1', name: 'Owner', handle: 'owner', email: 'a@example.com', passwordHash: 'hash', createdAt: when });
  state.sessions.push({ tokenHash: 'session', userId: 'user-1', expiresAt: when });
  state.workspaces.push({ id: 'space-1', ownerId: 'user-1', name: 'Space', createdAt: when });
  state.projects.push({ id: 'project-1', workspaceId: 'space-1', parentProjectId: null, name: 'Project', description: '',
    brief: { purpose: 'Ship' }, scopePlan: '', reviewInstructions: '', createdBy: owner, createdAt: when,
    workLocations: [{ id: 'location-1', label: 'Repo', kind: 'link', target: 'https://example.com', createdAt: when }] });
  state.agentInvites.push({ id: 'invite-1', workspaceId: 'space-1', rootProjectId: 'project-1', secretHash: 'secret',
    createdBy: owner, createdAt: when, expiresAt: when, maxUses: 2, useCount: 1, revokedAt: null,
    redemptions: [{ agentId: 'agent-1', name: 'Agent One', createdAt: when }] });
  state.agents.push({ id: 'agent-1', workspaceId: 'space-1', rootProjectId: 'project-1', inviteId: 'invite-1',
    name: 'Agent One', tokenHash: 'agent-token', canReview: false, createdAt: when, revokedAt: null });
  state.goals.push({ id: 'goal-1', projectId: 'project-1', title: 'Goal', description: '', createdBy: owner, createdAt: when });
  const run = { id: 'run-1', directions: { branch: 'main' }, startingPoint: null, startedBy: actor, startedAt: when };
  const submission = { id: 'submission-1', summary: 'Ready', submittedBy: actor, submittedAt: when,
    run, reviewEvidence: { artifacts: [], checks: [], notes: '' } };
  const decision = { submissionId: 'submission-1', outcome: 'approved', note: 'Looks good', decidedBy: owner, decidedAt: when };
  state.jobs.push({ id: 'job-1', projectId: 'project-1', goalId: 'goal-1', title: 'Job', body: '',
    startingPoint: { branch: 'main' }, status: 'completed', assignee: actor, createdBy: owner,
    createdAt: when, updatedAt: when, run, runs: [run], submission, submissionHistory: [submission],
    reviewDecision: decision, reviewHistory: [decision] });
  state.comments.push({ id: 'comment-1', projectId: 'project-1', goalId: 'goal-1', jobId: 'job-1',
    author: actor, body: 'Done', createdAt: when });
  state.activity.push({ id: 1, projectId: 'project-1', goalId: 'goal-1', jobId: 'job-1',
    actor, action: 'job.completed', detail: 'Done', createdAt: when });
  state.nextActivityId = 2;
  return state;
}

test('normalized rows hydrate nested histories, actor refs, and activity IDs', () => {
  const original = populated();
  const rows = flattenState(original);
  assert.equal(rows.project_work_locations.length, 1);
  assert.equal(rows.agent_invite_redemptions.length, 1);
  assert.equal(rows.job_runs.length, 1);
  assert.equal(rows.job_submissions[0].run_id, 'run-1');
  assert.equal(rows.job_review_decisions[0].id, 'job-1:review:1');
  const restored = hydrateState(rows, original.nextActivityId);
  assert.deepEqual(restored, original);
});

test('row diff skips unchanged rows and updates only changed entities', () => {
  const before = populated();
  const after = structuredClone(before);
  after.comments[0].body = 'Changed';
  after.jobs[0].updatedAt = '2026-09-23T12:01:00.000Z';
  after.activity.push({ id: 2, projectId: 'project-1', goalId: 'goal-1', jobId: 'job-1',
    actor, action: 'job.comment', detail: 'Changed', createdAt: when });
  after.nextActivityId = 3;
  const diff = diffState(before, after);
  assert.deepEqual(diff.insert.map(change => change.table), ['activity']);
  assert.deepEqual(diff.update.map(change => change.table), ['jobs', 'comments']);
  assert.deepEqual(diff.delete, []);
});

test('Google identity is a separate relational row linked to its user', () => {
  const before = populated();
  const after = structuredClone(before);
  after.authIdentities.push({ id: 'identity-1', userId: 'user-1', provider: 'google', subject: 'google-sub-1', emailAtLink: 'a@example.com', createdAt: when });
  const diff = diffState(before, after);
  assert.deepEqual(diff.insert.map(change => change.table), ['auth_identities']);
  assert.deepEqual(hydrateState(flattenState(after), after.nextActivityId), after);
});

test('coordination records round-trip through relational rows', () => {
  const original = populated();
  original.workspaces[0].paused = true;
  original.agents[0].canManage = true;
  original.jobs[0].assignedAgentId = 'agent-1';
  original.announcements.push({ id: 'announcement-1', workspaceId: 'space-1', kind: 'pause', body: 'Stop',
    targetAgentId: null, jobId: null, from: owner, receipts: [{ agentId: 'agent-1', readAt: null }], createdAt: when });
  original.meetings.push({ id: 'meeting-1', workspaceId: 'space-1', title: 'Board', mainAgentId: 'agent-1',
    participantIds: ['agent-1'], autoMode: false, status: 'active', createdAt: when, updatedAt: when });
  original.meetingRounds.push({ id: 'round-1', meetingId: 'meeting-1', ordinal: 1, prompt: 'Question',
    mode: 'blind', targetAgentId: null, participantIds: ['agent-1'], mainAgentId: 'agent-1',
    stage: 'complete', createdAt: when, completedAt: when });
  original.meetingResponses.push({ id: 'response-1', roundId: 'round-1', agentId: 'agent-1', kind: 'answer', body: 'Answer', createdAt: when });
  original.meetingVotes.push({ id: 'vote-1', roundId: 'round-1', agentId: 'agent-1', mode: 'open', createdAt: when });
  original.meetingMemories.push({ id: 'memory-1', workspaceId: 'space-1', agentId: 'agent-1', body: 'Note', updatedAt: when });
  const rows = flattenState(original);
  assert.deepEqual(rows.announcements[0].receipts, [{ agentId: 'agent-1', readAt: null }]);
  assert.deepEqual(hydrateState(rows, original.nextActivityId), original);
});

test('removing a work location deletes only its child row', () => {
  const before = populated();
  const after = structuredClone(before);
  after.projects[0].workLocations = [];
  const diff = diffState(before, after);
  assert.deepEqual(diff.insert, []);
  assert.deepEqual(diff.update, []);
  assert.deepEqual(diff.delete.map(change => change.table), ['project_work_locations']);
});

test('legacy current job records survive when history arrays are absent', () => {
  const original = populated();
  delete original.jobs[0].runs;
  delete original.jobs[0].submissionHistory;
  delete original.jobs[0].reviewHistory;
  const rows = flattenState(original);
  assert.equal(rows.job_runs.length, 1);
  assert.equal(rows.job_submissions.length, 1);
  assert.equal(rows.job_review_decisions.length, 1);
  const restored = hydrateState(rows, 2).jobs[0];
  assert.equal(restored.run.id, 'run-1');
  assert.equal(restored.submission.id, 'submission-1');
  assert.equal(restored.reviewDecision.outcome, 'approved');
});
