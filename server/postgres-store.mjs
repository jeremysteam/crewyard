import postgres from 'postgres';

// These names also define foreign-key-safe insertion order. Deletes run in reverse.
const collections = [
  ['users', 'users'], ['authIdentities', 'auth_identities'], ['sessions', 'sessions'], ['workspaces', 'workspaces'],
  ['projects', 'projects'], ['agentInvites', 'agent_invites'], ['agents', 'agents'],
  ['goals', 'goals'], ['jobs', 'jobs'], ['jobRequests', 'job_requests'],
  ['scopeProposals', 'scope_proposals'], ['comments', 'comments'], ['votes', 'votes'],
  ['announcements', 'announcements'], ['mentions', 'mentions'], ['activity', 'activity'], ['folderPairings', 'folder_pairings'],
  ['folders', 'folders'], ['meetings', 'meetings'],
  ['meetingRounds', 'meeting_rounds'], ['meetingResponses', 'meeting_responses'],
  ['meetingVotes', 'meeting_votes'], ['meetingMemories', 'meeting_memories'],
];
const childTables = ['project_work_locations', 'agent_invite_redemptions', 'job_runs', 'job_submissions', 'job_review_decisions'];
const tables = [...collections.map(([, table]) => table), ...childTables];
const actors = {
  projects: ['createdBy'], agent_invites: ['createdBy'], goals: ['createdBy'],
  jobs: ['assignee', 'createdBy'], job_requests: ['askedBy', 'respondedBy', 'cancelledBy'],
  scope_proposals: ['submittedBy', 'decidedBy'], comments: ['author'], votes: ['voter'],
  mentions: ['from'], announcements: ['from'], activity: ['actor'], job_runs: ['startedBy'],
  job_submissions: ['submittedBy'], job_review_decisions: ['decidedBy'],
};
const jsonColumns = {
  projects: ['brief'], scope_proposals: ['brief', 'applied_brief'],
  jobs: ['starting_point'], job_runs: ['directions', 'starting_point'],
  job_submissions: ['review_evidence'], announcements: ['receipts'],
  meetings: ['participant_ids'], meeting_rounds: ['participant_ids'],
};
const nested = new Set(['workLocations', 'redemptions', 'run', 'runs', 'submission', 'submissionHistory', 'reviewDecision', 'reviewHistory']);
const snake = key => key.replace(/[A-Z]/g, letter => '_' + letter.toLowerCase());
const camel = key => key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
const keyColumn = table => table === 'sessions' ? 'token_hash' : table === 'agent_invite_redemptions' ? 'agent_id' : 'id';
const rowKey = (table, row) => String(row[keyColumn(table)]);
const stamp = value => value instanceof Date ? value.toISOString() : typeof value === 'bigint' ? Number(value) : value;

function encode(table, value) {
  const row = {};
  for (const [field, item] of Object.entries(value)) {
    if (nested.has(field) || table === 'jobs' && field.startsWith('current')) continue;
    if (actors[table]?.includes(field)) {
      for (const part of ['type', 'id', 'name', 'handle']) row[snake(field) + '_' + part] = item?.[part] ?? null;
    } else row[snake(field)] = item ?? null;
  }
  if (table === 'jobs') {
    row.current_run_id = value.run?.id ?? null;
    row.current_submission_id = value.submission?.id ?? null;
    row.current_review_decision_id = value.reviewDecision ? value.id + ':review:' + (value.reviewHistory || []).length : null;
  }
  return row;
}

function decode(table, row) {
  const value = {};
  const names = actors[table] || [];
  const actorColumns = new Set(names.flatMap(name => ['type', 'id', 'name', 'handle'].map(part => snake(name) + '_' + part)));
  for (const [column, item] of Object.entries(row)) if (!actorColumns.has(column)) value[camel(column)] = stamp(item);
  for (const name of names) {
    const prefix = snake(name) + '_';
    value[name] = row[prefix + 'id'] == null ? null : {
      type: row[prefix + 'type'], id: row[prefix + 'id'],
      name: row[prefix + 'name'], handle: row[prefix + 'handle'],
    };
  }
  return value;
}

export function flattenState(state) {
  const rows = Object.fromEntries(tables.map(table => [table, []]));
  for (const [name, table] of collections) for (const entity of state[name] || []) rows[table].push(encode(table, entity));
  for (const project of state.projects || [])
    for (const item of project.workLocations || []) rows.project_work_locations.push(encode('project_work_locations', { ...item, projectId: project.id }));
  for (const invite of state.agentInvites || [])
    for (const item of invite.redemptions || []) rows.agent_invite_redemptions.push(encode('agent_invite_redemptions', { ...item, inviteId: invite.id }));
  for (const job of state.jobs || []) {
    const runs = [...(job.runs || [])];
    if (job.run && !runs.some(item => item.id === job.run.id)) runs.push(job.run);
    const submissions = [...(job.submissionHistory || [])];
    if (job.submission && !submissions.some(item => item.id === job.submission.id)) submissions.push(job.submission);
    const decisions = [...(job.reviewHistory || [])];
    if (job.reviewDecision && !decisions.some(item => item === job.reviewDecision || JSON.stringify(item) === JSON.stringify(job.reviewDecision))) decisions.push(job.reviewDecision);
    // Current decision pointer must use the normalized history length.
    if (job.reviewDecision) rows.jobs.find(row => row.id === job.id).current_review_decision_id = job.id + ':review:' + (decisions.findIndex(item => item === job.reviewDecision || JSON.stringify(item) === JSON.stringify(job.reviewDecision)) + 1);
    for (const [index, item] of runs.entries())
      rows.job_runs.push(encode('job_runs', { ...item, jobId: job.id, ordinal: index + 1 }));
    for (const [index, item] of submissions.entries()) {
      const { run, ...submission } = item;
      rows.job_submissions.push(encode('job_submissions', { ...submission, jobId: job.id, ordinal: index + 1, runId: run?.id ?? null }));
    }
    for (const [index, item] of decisions.entries())
      rows.job_review_decisions.push(encode('job_review_decisions', { ...item, id: job.id + ':review:' + (index + 1), jobId: job.id, ordinal: index + 1 }));
  }
  return rows;
}

export function hydrateState(rows, nextActivityId) {
  const state = Object.fromEntries(collections.filter(([, table]) => rows[table] !== undefined).map(([name, table]) => [name, rows[table].map(row => decode(table, row))]));
  state.nextActivityId = Number(nextActivityId);
  const projects = new Map(state.projects.map(item => [item.id, item]));
  for (const item of state.projects) item.workLocations = [];
  for (const row of rows.project_work_locations || []) {
    const { projectId, ...item } = decode('project_work_locations', row);
    projects.get(projectId)?.workLocations.push(item);
  }
  const invites = new Map(state.agentInvites.map(item => [item.id, item]));
  for (const item of state.agentInvites) item.redemptions = [];
  for (const row of rows.agent_invite_redemptions || []) {
    const { inviteId, ...item } = decode('agent_invite_redemptions', row);
    invites.get(inviteId)?.redemptions.push(item);
  }
  const jobs = new Map(state.jobs.map(item => [item.id, item]));
  const pointers = new Map();
  for (const job of state.jobs) {
    pointers.set(job.id, [job.currentRunId, job.currentSubmissionId, job.currentReviewDecisionId]);
    delete job.currentRunId; delete job.currentSubmissionId; delete job.currentReviewDecisionId;
    job.runs = []; job.submissionHistory = []; job.reviewHistory = [];
  }
  for (const row of rows.job_runs || []) {
    const { jobId, ordinal, ...item } = decode('job_runs', row);
    jobs.get(jobId)?.runs.push({ ordinal, item });
  }
  for (const job of state.jobs) job.runs = job.runs.sort((a, b) => a.ordinal - b.ordinal).map(entry => entry.item);
  const runs = new Map(state.jobs.flatMap(job => job.runs.map(item => [item.id, item])));
  for (const row of rows.job_submissions || []) {
    const { jobId, ordinal, runId, ...item } = decode('job_submissions', row);
    item.run = runId ? runs.get(runId) || null : null;
    jobs.get(jobId)?.submissionHistory.push({ ordinal, item });
  }
  for (const job of state.jobs) job.submissionHistory = job.submissionHistory.sort((a, b) => a.ordinal - b.ordinal).map(entry => entry.item);
  for (const row of rows.job_review_decisions || []) {
    const { id, jobId, ordinal, ...item } = decode('job_review_decisions', row);
    jobs.get(jobId)?.reviewHistory.push({ id, ordinal, item });
  }
  for (const job of state.jobs) {
    const decisions = job.reviewHistory.sort((a, b) => a.ordinal - b.ordinal);
    job.reviewHistory = decisions.map(entry => entry.item);
    const [runId, submissionId, decisionId] = pointers.get(job.id);
    if (runId) job.run = job.runs.find(item => item.id === runId);
    if (submissionId) job.submission = job.submissionHistory.find(item => item.id === submissionId);
    if (decisionId) job.reviewDecision = decisions.find(entry => entry.id === decisionId)?.item;
  }
  return state;
}

async function load(sql, { omitHeavy = false, commentJobId = null, commentGoalId = null } = {}) {
  const entries = await Promise.all(tables.map(async table => {
    if (table === 'comments') {
      if (commentJobId) return [table, await sql`SELECT * FROM board_private.comments WHERE job_id = ${commentJobId} ORDER BY created_at, id`];
      if (commentGoalId) return [table, await sql`SELECT * FROM board_private.comments WHERE goal_id = ${commentGoalId} ORDER BY created_at, id`];
      if (omitHeavy) return [table, []];
      return [table, await sql`SELECT * FROM board_private.comments ORDER BY created_at, id`];
    }
    if (table === 'activity') return [table, omitHeavy ? [] : await sql`SELECT * FROM board_private.activity ORDER BY id`];
    if (table === 'mentions') return [table, omitHeavy ? [] : await sql`SELECT * FROM board_private.mentions ORDER BY created_at, id`];
    if (childTables.includes(table) && table.startsWith('job_')) return [table, await sql`SELECT * FROM board_private.${sql(table)} ORDER BY job_id, ordinal`];
    return [table, await sql`SELECT * FROM board_private.${sql(table)} ORDER BY ${sql(keyColumn(table))}`];
  }));
  const counter = await sql`SELECT next_id FROM board_private.activity_counter WHERE singleton = true`;
  if (counter.length !== 1) throw new Error('Board database schema is missing; apply the reviewed SQL first');
  return hydrateState(Object.fromEntries(entries), counter[0].next_id);
}

export function diffState(before, after) {
  const oldRows = flattenState(before), newRows = flattenState(after);
  const result = { insert: [], update: [], delete: [] };
  for (const table of tables) {
    const old = new Map(oldRows[table].map(row => [rowKey(table, row), row]));
    const current = new Map(newRows[table].map(row => [rowKey(table, row), row]));
    for (const [id, row] of current) {
      if (!old.has(id)) result.insert.push({ table, row });
      else if (JSON.stringify(row) !== JSON.stringify(old.get(id))) result.update.push({ table, row });
    }
    for (const [id] of old) if (!current.has(id)) result.delete.push({ table, id });
  }
  return result;
}

async function persist(sql, before, after) {
  const diff = diffState(before, after);
  const values = (table, row) => Object.fromEntries(Object.entries(row).map(([key, value]) =>
    [key, jsonColumns[table]?.includes(key) && value !== null ? sql.json(value) : value]));
  for (const { table, row } of diff.insert) await sql`INSERT INTO board_private.${sql(table)} ${sql(values(table, row))}`;
  for (const { table, row } of diff.update) {
    const id = row[keyColumn(table)];
    const rest = { ...row }; delete rest[keyColumn(table)];
    await sql`UPDATE board_private.${sql(table)} SET ${sql(values(table, rest))} WHERE ${sql(keyColumn(table))} = ${id}`;
  }
  for (const { table, id } of diff.delete.reverse())
    await sql`DELETE FROM board_private.${sql(table)} WHERE ${sql(keyColumn(table))} = ${id}`;
  if (before.nextActivityId !== after.nextActivityId)
    await sql`UPDATE board_private.activity_counter SET next_id = ${after.nextActivityId} WHERE singleton = true`;
}

async function assertActorActive(tx, { actor, agentTokenHash, sessionTokenHash }) {
  let active = false;
  if (actor.kind === 'agent') {
    if (agentTokenHash) {
      const rows = await tx`SELECT id FROM board_private.agents WHERE id = ${actor.id} AND token_hash = ${agentTokenHash} AND root_project_id = ${actor.rootProjectId} AND revoked_at IS NULL`;
      active = rows.length === 1;
    }
  } else if (sessionTokenHash) {
    const rows = await tx`SELECT user_id FROM board_private.sessions WHERE user_id = ${actor.id} AND token_hash = ${sessionTokenHash} AND expires_at > now()`;
    active = rows.length === 1;
  }
  if (!active) { const error = new Error('Sign in or connect an agent'); error.status = 401; throw error; }
}

export function createPostgresStore(connectionString) {
  // Local disposable PostgreSQL can opt out of TLS explicitly; hosted DBs use TLS.
  const ssl = new URL(connectionString).searchParams.get('sslmode') === 'disable' ? false : 'require';
  const sql = postgres(connectionString, { max: 3, prepare: false, ssl });
  return {
    close: () => sql.end(),
    health: async () => {
      if ((await sql`SELECT 1 FROM board_private.activity_counter WHERE singleton = true`).length !== 1) throw new Error('Board database schema is missing; apply the reviewed SQL first');
      await sql`SELECT 1 FROM board_private.auth_identities LIMIT 0`;
      await sql`SELECT paused FROM board_private.workspaces LIMIT 0`;
      await sql`SELECT can_manage FROM board_private.agents LIMIT 0`;
      await sql`SELECT assigned_agent_id FROM board_private.jobs LIMIT 0`;
      await sql`SELECT announcement_id FROM board_private.mentions LIMIT 0`;
      await sql`SELECT 1 FROM board_private.meeting_memories LIMIT 0`;
    },
    resolveActor: async ({ agentTokenHash, sessionTokenHash } = {}) => {
      if (agentTokenHash) {
        const rows = await sql`SELECT id, name, workspace_id, root_project_id, can_review, can_manage FROM board_private.agents WHERE token_hash = ${agentTokenHash} AND revoked_at IS NULL`;
        const agent = rows[0];
        return agent?.root_project_id ? { kind: 'agent', id: agent.id, name: agent.name, handle: agent.name, workspaceId: agent.workspace_id, rootProjectId: agent.root_project_id, canReview: agent.can_review === true, canManage: agent.can_manage === true } : null;
      }
      if (sessionTokenHash) {
        const rows = await sql`SELECT u.id, u.name, u.handle FROM board_private.sessions s JOIN board_private.users u ON u.id = s.user_id WHERE s.token_hash = ${sessionTokenHash} AND s.expires_at > now()`;
        const user = rows[0];
        return user ? { kind: 'user', id: user.id, name: user.name, handle: user.handle } : null;
      }
      return null;
    },
    listMentions: ({ actor, since = null, unreadOnly = false, agentTokenHash, sessionTokenHash }) => sql.begin(async tx => {
      await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
      await assertActorActive(tx, { actor, agentTokenHash, sessionTokenHash });
      const sinceTime = since && !Number.isNaN(Date.parse(since)) ? new Date(since).toISOString() : null;
      const count = await tx`SELECT count(*)::integer AS unread FROM board_private.mentions WHERE recipient_type = ${actor.kind} AND recipient_id = ${actor.id} AND read_at IS NULL`;
      const records = unreadOnly
        ? await tx`SELECT * FROM board_private.mentions WHERE recipient_type = ${actor.kind} AND recipient_id = ${actor.id} AND read_at IS NULL AND (${sinceTime}::timestamptz IS NULL OR created_at > ${sinceTime}::timestamptz) ORDER BY created_at, id`
        : await tx`SELECT * FROM board_private.mentions WHERE recipient_type = ${actor.kind} AND recipient_id = ${actor.id} ORDER BY created_at DESC, id DESC LIMIT 100`;
      return { unread: count[0].unread, mentions: records.map(row => decode('mentions', row)) };
    }),
    markMentionsRead: ({ actor, ids = null, readAt = new Date().toISOString(), agentTokenHash, sessionTokenHash }) => sql.begin(async tx => {
      await tx`SELECT pg_advisory_xact_lock(1549452384, 1)`;
      await assertActorActive(tx, { actor, agentTokenHash, sessionTokenHash });
      const selected = ids === null ? null : [...ids];
      if (ids === null) await tx`UPDATE board_private.mentions SET read_at = ${readAt} WHERE recipient_type = ${actor.kind} AND recipient_id = ${actor.id}`;
      else if (selected.length) await tx`UPDATE board_private.mentions SET read_at = ${readAt} WHERE recipient_type = ${actor.kind} AND recipient_id = ${actor.id} AND id IN ${tx(selected)}`;
    }),
    listActivity: ({ actor, projectId, since = 0, agentTokenHash, sessionTokenHash }) => sql.begin(async tx => {
      await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
      await assertActorActive(tx, { actor, agentTokenHash, sessionTokenHash });
      const allowed = actor.kind === 'user'
        ? await tx`SELECT p.id FROM board_private.projects p JOIN board_private.workspaces w ON w.id = p.workspace_id WHERE p.id = ${projectId} AND w.owner_id = ${actor.id}`
        : await tx`SELECT id FROM board_private.projects WHERE id = ${projectId} AND workspace_id = ${actor.workspaceId} AND coalesce(parent_project_id,id) = ${actor.rootProjectId}`;
      if (!allowed.length) { const error = new Error('Project not found'); error.status = 404; throw error; }
      const minimum = Number.isFinite(Number(since)) ? Number(since) : 0;
      const records = await tx`SELECT a.* FROM board_private.activity a WHERE a.id > ${minimum} AND (a.project_id = ${projectId} OR a.project_id IN (SELECT id FROM board_private.projects WHERE parent_project_id = ${projectId})) ORDER BY a.id LIMIT 200`;
      return records.map(row => decode('activity', row));
    }),
    read: (fn, options = {}) => sql.begin(async tx => {
      await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
      return fn(await load(tx, options));
    }),
    write: fn => sql.begin(async tx => {
      // The callback API needs a single writer across all server instances.
      await tx`SELECT pg_advisory_xact_lock(1549452384, 1)`;
      // App writes only append to these event collections. Their older rows are
      // intentionally absent on both sides of the diff; only new rows insert.
      const before = await load(tx, { omitHeavy: true });
      const after = structuredClone(before);
      const result = await fn(after);
      await persist(tx, before, after);
      return result;
    }),
  };
}
