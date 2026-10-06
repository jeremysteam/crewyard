import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { writeScopeFor } from './operation-scope.mjs';
import { createBudgetLimiter, defaultLimits } from './request-budget.mjs';
import { createStorageMetrics } from './storage-metrics.mjs';

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
    if (field==='_ordinal' || field==='historyPage' || nested.has(field) || table === 'jobs' && field.startsWith('current')) continue;
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
    const ordinals=items=>{let next=items.reduce((max,item)=>Math.max(max,item._ordinal||0),0);return items.map(item=>item._ordinal||++next);};
    const runOrdinals=ordinals(runs),submissionOrdinals=ordinals(submissions),decisionOrdinals=ordinals(decisions);
    // Current decision pointer must use the normalized history length.
    if (job.reviewDecision) rows.jobs.find(row => row.id === job.id).current_review_decision_id = job.id + ':review:' + decisionOrdinals[decisions.findIndex(item => item === job.reviewDecision || JSON.stringify(item) === JSON.stringify(job.reviewDecision))];
    for (const [index, item] of runs.entries())
      rows.job_runs.push(encode('job_runs', { ...item, jobId: job.id, ordinal: runOrdinals[index] }));
    for (const [index, item] of submissions.entries()) {
      const { run, ...submission } = item;
      rows.job_submissions.push(encode('job_submissions', { ...submission, jobId: job.id, ordinal: submissionOrdinals[index], runId: run?.id ?? null }));
    }
    for (const [index, item] of decisions.entries())
      rows.job_review_decisions.push(encode('job_review_decisions', { ...item, id: job.id + ':review:' + decisionOrdinals[index], jobId: job.id, ordinal: decisionOrdinals[index] }));
  }
  return rows;
}

export function hydrateState(rows, nextActivityId, {trackOrdinals=false}={}) {
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
    if(trackOrdinals)item._ordinal=ordinal;
    jobs.get(jobId)?.runs.push({ ordinal, item });
  }
  for (const job of state.jobs) job.runs = job.runs.sort((a, b) => a.ordinal - b.ordinal).map(entry => entry.item);
  const runs = new Map(state.jobs.flatMap(job => job.runs.map(item => [item.id, item])));
  for (const row of rows.job_submissions || []) {
    const { jobId, ordinal, runId, ...item } = decode('job_submissions', row);
    if(trackOrdinals)item._ordinal=ordinal;
    item.run = runId ? runs.get(runId) || null : null;
    jobs.get(jobId)?.submissionHistory.push({ ordinal, item });
  }
  for (const job of state.jobs) job.submissionHistory = job.submissionHistory.sort((a, b) => a.ordinal - b.ordinal).map(entry => entry.item);
  for (const row of rows.job_review_decisions || []) {
    const { id, jobId, ordinal, ...item } = decode('job_review_decisions', row);
    if(trackOrdinals)item._ordinal=ordinal;
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

// Every filter is parameterized; authentication remains fresh inside the read transaction.
export async function loadScoped(sql, options) {
  const { actor, selectedTables, sessionTokenHash, jobId, goalId, projectId, workspaceId, meetingId, writeMode } = options;
  const workspaceIds = workspaceId ? sql`SELECT id FROM board_private.workspaces WHERE id = ${workspaceId} AND (owner_id = ${actor.id} OR id = ${actor.kind === 'agent' ? actor.workspaceId : null})` : actor.kind === 'user'
    ? sql`SELECT id FROM board_private.workspaces WHERE owner_id = ${actor.id}`
    : sql`SELECT id FROM board_private.workspaces WHERE id = ${actor.workspaceId}`;
  const projectIds = actor.kind === 'user' || options.workspaceWide
    ? sql`SELECT id FROM board_private.projects WHERE workspace_id IN (${workspaceIds})`
    : sql`SELECT id FROM board_private.projects WHERE workspace_id IN (${workspaceIds}) AND coalesce(parent_project_id, id) = ${actor.rootProjectId}`;
  const branchIds = projectId ? sql`SELECT id FROM board_private.projects WHERE (id = ${projectId} OR parent_project_id = ${projectId}) AND id IN (${projectIds})` : projectIds;
  const jobIds = jobId ? sql`SELECT id FROM board_private.jobs WHERE id = ${jobId} AND project_id IN (${projectIds})`
    : goalId ? sql`SELECT id FROM board_private.jobs WHERE goal_id = ${goalId} AND project_id IN (${projectIds})`
    : options.reviewQueue ? sql`SELECT id FROM board_private.jobs WHERE project_id IN (${branchIds}) AND status='review' ORDER BY updated_at DESC,id DESC LIMIT 51` : sql`SELECT id FROM board_private.jobs WHERE project_id IN (${branchIds})`;
  const meetingIds = meetingId ? sql`SELECT id FROM board_private.meetings WHERE id = ${meetingId} AND workspace_id IN (${workspaceIds})` : sql`SELECT id FROM board_private.meetings WHERE workspace_id IN (${workspaceIds})`;
  const roundIds = !writeMode && meetingId ? sql`SELECT id FROM board_private.meeting_rounds WHERE meeting_id IN (${meetingIds}) AND (${options.roundBefore||null}::integer IS NULL OR ordinal < ${options.roundBefore||null}) ORDER BY ordinal DESC LIMIT 21` : meetingId && writeMode ? sql`SELECT id FROM board_private.meeting_rounds WHERE meeting_id IN (${meetingIds}) AND (id=${options.targetRoundId||null} OR ordinal IN (SELECT ordinal FROM board_private.meeting_rounds WHERE meeting_id IN (${meetingIds}) ORDER BY ordinal DESC LIMIT 2))` : sql`SELECT id FROM board_private.meeting_rounds WHERE meeting_id IN (${meetingIds})`;
  const workspaceTables = new Set(['agents', 'agent_invites', 'announcements', 'meetings', 'meeting_memories']);
  const projectTables = new Set(['goals', 'jobs', 'job_requests', 'scope_proposals', 'comments', 'folder_pairings', 'folders', 'project_work_locations']);
  const wanted = new Set(selectedTables);
  const entries = await Promise.all(tables.map(async table => {
    if (!wanted.has(table) || options.appendOnly?.has(table)) return [table, []];
    let filter;
    if (table === 'users') filter = sql`id IN (SELECT owner_id FROM board_private.workspaces WHERE id IN (${workspaceIds})) OR id = ${actor.id}`;
    else if (table === 'sessions') filter = sql`token_hash = ${sessionTokenHash} AND expires_at > now()`;
    else if (table === 'workspaces') filter = sql`id IN (${workspaceIds})`;
    else if (table === 'projects') filter = sql`id IN (${projectIds})`;
    else if (table === 'meetings') filter = sql`id IN (${meetingIds})`;
    else if (table === 'meeting_memories') filter = actor.kind === 'agent' ? sql`workspace_id IN (${workspaceIds}) AND agent_id = ${actor.id}` : sql`false`;
    else if (table === 'announcements' && options.announcementId) filter = sql`workspace_id IN (${workspaceIds}) AND id = ${options.announcementId}`;
    else if (table==='agents' && actor.kind==='agent' && !options.fullRoster) filter=sql`id=${actor.id}`;
    else if (workspaceTables.has(table)) filter = sql`workspace_id IN (${workspaceIds})`;
    else if (table === 'agent_invite_redemptions') filter = sql`invite_id IN (SELECT id FROM board_private.agent_invites WHERE workspace_id IN (${workspaceIds}))`;
    else if (table === 'meeting_rounds') filter = sql`id IN (${roundIds})`;
    else if (table === 'meeting_responses' || table === 'meeting_votes') filter = sql`round_id IN (${roundIds})`;
    else if (table.startsWith('job_') && childTables.includes(table)) filter = sql`job_id IN (${jobIds})`;
    else if (table === 'jobs') filter = sql`id IN (${jobIds})`;
    else if (table === 'comments' && jobId) filter = sql`job_id = ${jobId} AND project_id IN (${projectIds})`;
    else if (table === 'comments' && goalId) filter = sql`goal_id = ${goalId} AND project_id IN (${projectIds})`;
    else if (table === 'votes' || (table === 'job_requests' && jobId)) filter = sql`job_id IN (${jobIds})`;
    else if (projectTables.has(table)) filter = sql`project_id IN (${branchIds})`;
    else throw new Error('Missing read filter for ' + table);
    if(!writeMode&&table==='comments'&&options.pageCursor)filter=sql`${filter} AND (created_at,id) < (${options.pageCursor[0]}::timestamptz,${options.pageCursor[1]})`;
    if(!writeMode&&table==='jobs'&&options.pageJobs){
      filter=sql`project_id=${options.pageProjectId} AND project_id IN (${projectIds})`;
      if(options.pageCursor)filter=sql`${filter} AND (updated_at,id) < (${options.pageCursor[0]}::timestamptz,${options.pageCursor[1]})`;
    }
    const order = table === 'meeting_rounds' ? sql`ordinal` : childTables.includes(table) && table.startsWith('job_')
      ? sql`job_id, ordinal` : table === 'comments' ? sql`created_at, id` : sql`${sql(keyColumn(table))}`;
    const fields = table === 'users' ? sql`id, name, handle, email` : sql`*`;
    if(!writeMode && table==='announcements'){
      const records=actor.kind==='agent'
        ? await sql`SELECT id,workspace_id,kind,body,target_agent_id,job_id,from_type,from_id,from_name,from_handle,created_at,coalesce((SELECT jsonb_agg(r) FROM jsonb_array_elements(receipts) r WHERE r->>'agentId'=${actor.id}),'[]'::jsonb) AS receipts FROM board_private.announcements WHERE ${filter} ORDER BY created_at DESC,id DESC LIMIT 200`
        : await sql`SELECT * FROM board_private.announcements WHERE ${filter} ORDER BY created_at DESC,id DESC LIMIT 200`;
      options.onRows?.(table,records);return [table,records.reverse()];
    }
    if(options.reviewQueue && ['job_runs','job_submissions','job_review_decisions'].includes(table)){
      const pointer={job_runs:'current_run_id',job_submissions:'current_submission_id',job_review_decisions:'current_review_decision_id'}[table];
      const records=await sql`SELECT * FROM board_private.${sql(table)} WHERE id IN (SELECT ${sql(pointer)} FROM board_private.jobs WHERE id IN (${jobIds})) ${table==='job_runs'?sql`OR id IN (SELECT run_id FROM board_private.job_submissions WHERE id IN (SELECT current_submission_id FROM board_private.jobs WHERE id IN (${jobIds})))`:sql``}`;
      options.onRows?.(table,records);return [table,records];
    }
    if(writeMode && table==='job_requests'){
      const records=await sql`SELECT * FROM board_private.job_requests WHERE job_id IN (${jobIds}) AND (status='pending' OR id=${options.requestId||null})`;
      options.onRows?.(table,records);return [table,records];
    }
    if(options.reviewQueue && table==='job_requests'){
      const records=await sql`SELECT * FROM board_private.job_requests WHERE job_id IN (${jobIds}) AND status='pending'`;
      options.onRows?.(table,records);return [table,records];
    }
    if(options.reviewQueue && table==='comments'){
      const records=await sql`SELECT c.* FROM (SELECT id FROM board_private.jobs WHERE id IN (${jobIds})) j CROSS JOIN LATERAL (SELECT * FROM board_private.comments WHERE job_id=j.id ORDER BY created_at DESC,id DESC LIMIT 5) c ORDER BY c.created_at,c.id`;
      options.onRows?.(table,records);return [table,records];
    }

    if(['job_runs','job_submissions','job_review_decisions'].includes(table)){
      const pointer={job_runs:'current_run_id',job_submissions:'current_submission_id',job_review_decisions:'current_review_decision_id'}[table];
      const window=writeMode?1:21;
      const subHistory=sql`SELECT id FROM board_private.job_submissions WHERE job_id IN (${jobIds}) AND (id IN (SELECT current_submission_id FROM board_private.jobs WHERE id IN (${jobIds})) OR ordinal IN (SELECT ordinal FROM board_private.job_submissions s WHERE s.job_id=job_submissions.job_id AND (${options.historyBefore||null}::integer IS NULL OR s.ordinal<${options.historyBefore||null}) ORDER BY ordinal DESC LIMIT ${window}))`;
      const runRefs=table==='job_runs'?sql` OR id IN (SELECT run_id FROM board_private.job_submissions WHERE id IN (${subHistory}))`:sql``;
      const pinned=options.historyPageMode?sql`false`:sql`id IN (SELECT ${sql(pointer)} FROM board_private.jobs WHERE id IN (${jobIds}))`;
      const records=await sql`SELECT h.* FROM (SELECT id FROM board_private.jobs WHERE id IN (${jobIds})) j CROSS JOIN LATERAL (SELECT * FROM board_private.${sql(table)} WHERE job_id=j.id AND (id IN (SELECT id FROM board_private.${sql(table)} recent WHERE recent.job_id=j.id AND (${options.historyBefore||null}::integer IS NULL OR recent.ordinal<${options.historyBefore||null}) ORDER BY ordinal DESC LIMIT ${window}) OR ${pinned}${runRefs})) h ORDER BY h.job_id,h.ordinal`;
      options.onRows?.(table,records);return [table,records];
    }
    if(!writeMode && table==='comments'){
      const records=await sql`SELECT * FROM board_private.comments WHERE ${filter} ORDER BY created_at DESC,id DESC LIMIT 51`;
      options.onRows?.(table,records);return [table,records.reverse()];
    }
    if(!writeMode && table==='jobs' && options.jobSummary){
      const records=await sql`SELECT id,project_id,goal_id,title,left(body,1000) AS body,status,assigned_agent_id,assignee_type,assignee_id,assignee_name,assignee_handle,created_by_type,created_by_id,created_by_name,created_by_handle,created_at,updated_at,starting_point,true AS body_is_preview FROM board_private.jobs WHERE ${filter} ORDER BY ${options.pageJobs ? sql`` : sql`(status <> 'completed') DESC,`} updated_at DESC,id DESC LIMIT ${options.pageJobs?51:201}`;
      options.onRows?.(table,records);return [table,records];
    }
    const records=await sql`SELECT ${fields} FROM board_private.${sql(table)} WHERE ${filter} ORDER BY ${order}`;
    options.onRows?.(table,records);return [table,records];
  }));
  // Read-only callbacks never allocate an event ID and need no counter lookup.
  const rowMap=Object.fromEntries(entries);
  const state=hydrateState(rowMap,1,{trackOrdinals:true});
  for(const item of state.jobs){
    item.historyPage={};
    for(const [kind,table]of [['runs','job_runs'],['submissions','job_submissions'],['reviews','job_review_decisions']]){
      const records=(rowMap[table]||[]).filter(row=>row.job_id===item.id).sort((a,b)=>b.ordinal-a.ordinal);
      item.historyPage[kind]=records.length>20?records[19].ordinal:null;
    }
  }
  if(!writeMode&&options.jobSummary&&!options.pageJobs){
    const totals=await sql`SELECT project_id,status,count(*)::integer AS total FROM board_private.jobs WHERE project_id IN (${projectIds}) GROUP BY project_id,status`;
    options.onRows?.('job_counts',totals);
    state.jobCounts=Object.fromEntries(totals.map(row=>[row.project_id+':'+row.status,row.total]));
    state.jobsTruncated=state.jobs.length>200;
    state.jobs=state.jobs.slice(0,200);
  }
  if(options.memoryHistory && actor.kind==='agent'){
    const records=await sql`SELECT m.title AS meeting_title,r.prompt,a.kind,left(a.body,2000) AS answer,a.created_at FROM board_private.meeting_responses a JOIN board_private.meeting_rounds r ON r.id=a.round_id JOIN board_private.meetings m ON m.id=r.meeting_id WHERE a.agent_id=${actor.id} AND m.workspace_id IN (${workspaceIds}) ORDER BY a.created_at DESC,a.id DESC LIMIT 10`;
    options.onRows?.('own_memory_history',records);
    state.agentMemoryHistory=records.reverse().map(row=>({meetingTitle:row.meeting_title,prompt:row.prompt,kind:row.kind,answer:row.answer,createdAt:stamp(row.created_at)}));
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

export async function persist(sql, before, after, { allocateActivity = false } = {}) {
  const diff = diffState(before, after);
  const values = (table, row) => Object.fromEntries(Object.entries(row).map(([key, value]) =>
    [key, jsonColumns[table]?.includes(key) && value !== null ? sql.json(value) : value]));
  for (const { table, row } of diff.insert.filter(item=>!allocateActivity||item.table!=='activity')) await sql`INSERT INTO board_private.${sql(table)} ${sql(values(table, row))}`;
  for (const { table, row } of diff.update) {
    const id = row[keyColumn(table)];
    const rest = { ...row }; delete rest[keyColumn(table)];
    await sql`UPDATE board_private.${sql(table)} SET ${sql(values(table, rest))} WHERE ${sql(keyColumn(table))} = ${id}`;
  }
  for (const { table, id } of diff.delete.reverse())
    await sql`DELETE FROM board_private.${sql(table)} WHERE ${sql(keyColumn(table))} = ${id}`;
  // Reserve event IDs after entity persistence, so the shared counter lock is
  // held only for final event inserts and commit, not the whole entity diff.
  if (allocateActivity && after.activity.length) {
    const count = after.activity.length;
    const reserved = await sql`UPDATE board_private.activity_counter SET next_id = next_id + ${count} WHERE singleton = true RETURNING next_id - ${count} AS start`;
    if (reserved.length !== 1) throw new Error('Activity counter is missing');
    after.activity.forEach((item, index) => { item.id = Number(reserved[0].start) + index; });
  }
  if(allocateActivity)for(const item of after.activity)await sql`INSERT INTO board_private.activity ${sql(values('activity',encode('activity',item)))}`;
  if (!allocateActivity && before.nextActivityId !== after.nextActivityId)
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


async function mutationWorkspace(sql, options) {
  const { actor, path } = options;
  let ids;
  const direct=path.match(/^\/api\/workspaces\/([^/]+)/)?.[1];
  if(direct) ids=sql`SELECT id FROM board_private.workspaces WHERE id = ${direct}`;
  else if(options.jobId) ids=sql`SELECT p.workspace_id AS id FROM board_private.jobs j JOIN board_private.projects p ON p.id=j.project_id WHERE j.id=${options.jobId}`;
  else if(options.goalId) ids=sql`SELECT p.workspace_id AS id FROM board_private.goals g JOIN board_private.projects p ON p.id=g.project_id WHERE g.id=${options.goalId}`;
  else if(options.meetingId) ids=sql`SELECT workspace_id AS id FROM board_private.meetings WHERE id=${options.meetingId}`;
  else if(options.projectId) ids=sql`SELECT workspace_id AS id FROM board_private.projects WHERE id=${options.projectId}`;
  else if(actor.workspaceId) ids=sql`SELECT id FROM board_private.workspaces WHERE id=${actor.workspaceId}`;
  else throw Object.assign(new Error('Workspace is required'),{status:404});
  const allowed=actor.kind==='user'
    ? await sql`SELECT id FROM board_private.workspaces WHERE id IN (${ids}) AND owner_id=${actor.id}`
    : await sql`SELECT id FROM board_private.workspaces WHERE id IN (${ids}) AND id=${actor.workspaceId}`;
  if(allowed.length!==1)throw Object.assign(new Error('Workspace not found'),{status:404});
  return allowed[0].id;
}


export async function lockMutation(sql,scope){
  const exclusive=/^\/api\/workspaces\/[^/]+\/(?:agents|announcements|projects)/.test(scope.path)||scope.path.includes('/agent-invites');
  // Pause/revocation/grant operations exclude active mutations. Independent
  // jobs, goals and meetings use shared workspace gates and their own row locks.
  if(exclusive)await sql`SELECT id FROM board_private.workspaces WHERE id=${scope.workspaceId} FOR UPDATE`;
  else await sql`SELECT id FROM board_private.workspaces WHERE id=${scope.workspaceId} FOR SHARE`;
  if(scope.actor.kind==='agent')await sql`SELECT id FROM board_private.agents WHERE id=${scope.actor.id} FOR SHARE`;
  else await sql`SELECT token_hash FROM board_private.sessions WHERE token_hash=${scope.sessionTokenHash} FOR SHARE`;
  if(scope.path.startsWith('/api/jobs/')&&scope.jobId)await sql`SELECT id FROM board_private.jobs WHERE id=${scope.jobId} FOR UPDATE`;
  else if(scope.goalId)await sql`SELECT id FROM board_private.goals WHERE id=${scope.goalId} FOR UPDATE`;
  else if(scope.meetingId)await sql`SELECT id FROM board_private.meetings WHERE id=${scope.meetingId} FOR UPDATE`;
  else if(scope.projectId)await sql`SELECT id FROM board_private.projects WHERE id=${scope.projectId} FOR UPDATE`;
  else if(scope.path==='/api/meeting-memory')await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'memory:'+scope.actor.id},1549452384))`;
}


export async function loadAccount(sql,options){
  const {path,input={},account={},sessionTokenHash,agentTokenHash}=options;
  const email=String(account.email||input.email||'').toLowerCase();
  const handle=account.handle||String(input.name||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,24)||'owner';
  const subject=account.subject||'';
  const currentUsers=sql`SELECT user_id FROM board_private.sessions WHERE token_hash=${sessionTokenHash} AND expires_at>now()`;
  const knownUsers=sql`SELECT user_id FROM board_private.auth_identities WHERE provider='google' AND subject=${subject}`;
  const result=Object.fromEntries(tables.map(table=>[table,[]]));
  if(path==='/api/auth/register')result.users=await sql`SELECT * FROM board_private.users WHERE email=${email} OR handle=${handle}`;
  else if(path==='/api/auth/login'){
    result.users=account.userId?await sql`SELECT * FROM board_private.users WHERE id=${account.userId}`:await sql`SELECT * FROM board_private.users WHERE email=${email}`;
    if(account.userId)result.workspaces=await sql`SELECT * FROM board_private.workspaces WHERE owner_id=${account.userId}`;
  }else if(path==='/api/auth/google'){
    result.users=await sql`SELECT * FROM board_private.users WHERE email=${email} OR handle=${handle} OR id IN (${knownUsers})`;
    result.auth_identities=await sql`SELECT * FROM board_private.auth_identities WHERE provider='google' AND subject=${subject}`;
    result.workspaces=await sql`SELECT * FROM board_private.workspaces WHERE owner_id IN (${knownUsers})`;
  }else if(path==='/api/auth/logout'||path==='/api/auth/google/link'){
    result.users=await sql`SELECT * FROM board_private.users WHERE id IN (${currentUsers})`;
    result.sessions=await sql`SELECT * FROM board_private.sessions WHERE token_hash=${sessionTokenHash}`;
    if(agentTokenHash)result.agents=await sql`SELECT * FROM board_private.agents WHERE token_hash=${agentTokenHash}`;
    if(path.endsWith('/link'))result.auth_identities=await sql`SELECT * FROM board_private.auth_identities WHERE (provider='google' AND subject=${subject}) OR user_id IN (${currentUsers})`;
  }else throw Object.assign(new Error('No account read scope for this endpoint'),{status:404});
  options.onRows&&Object.entries(result).forEach(([table,rows])=>{if(rows.length)options.onRows(table,rows);});
  return hydrateState(result,1);
}

export async function retryAccountWrite(run,path){
  for(let attempt=0;;attempt++)try{return await run();}catch(error){
    if(error.code==='23505'&&error.constraint_name==='users_handle_key'&&['/api/auth/register','/api/auth/google'].includes(path)&&attempt<3)continue;
    if(error.code==='23505'&&['users_email_key','auth_identities_provider_subject_key','auth_identities_user_id_provider_key'].includes(error.constraint_name))throw Object.assign(new Error('Account already exists or Google identity is linked. Sign in again or link from your existing account.'),{status:409});
    throw error;
  }
}

async function accountTransaction(sql,fn,options,fineWrites){
  const {path,input={},account={}}=options;
  if(!fineWrites)await sql`SELECT pg_advisory_xact_lock(1549452384,1)`;
  if(path==='/api/agent-enrollments'||path==='/api/folder-pairings/claim'){
    const secret=path==='/api/agent-enrollments'?input.invite:input.code;
    const secretHash=createHash('sha256').update(String(secret||'')).digest('hex');
    const records=path==='/api/agent-enrollments'
      ? await sql`SELECT workspace_id FROM board_private.agent_invites WHERE secret_hash=${secretHash}`
      : await sql`SELECT p.workspace_id FROM board_private.folder_pairings f JOIN board_private.projects p ON p.id=f.project_id WHERE f.code_hash=${secretHash} AND f.project_id=${input.projectId}`;
    if(!records.length)throw Object.assign(new Error('Invalid or unavailable connection code'),{status:path==='/api/agent-enrollments'?401:404});
    const workspaceId=records[0].workspace_id;
    const owners=await sql`SELECT owner_id FROM board_private.workspaces WHERE id=${workspaceId} FOR UPDATE`;
    if(!owners.length)throw Object.assign(new Error('Workspace not found'),{status:404});
    const scope={actor:{kind:'user',id:owners[0].owner_id},workspaceId,projectId:path==='/api/folder-pairings/claim'?input.projectId:null,writeMode:true,workspaceWide:true,
      selectedTables:['workspaces','projects','agents','agent_invites','agent_invite_redemptions','folder_pairings','folders']};
    const before=await loadScoped(sql,scope),after=structuredClone(before);
    const result=await fn(after);await persist(sql,before,after,{allocateActivity:true});
    return {result,workspaceId};
  }
  if(!['/api/auth/register','/api/auth/login','/api/auth/google','/api/auth/google/link','/api/auth/logout'].includes(path))throw Object.assign(new Error('No account mutation scope for this endpoint'),{status:404});
  const key='account:'+String(account.email||input.email||account.subject||options.sessionTokenHash||'');
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key},1549452384))`;
  if(account.subject)await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'google:'+account.subject},1549452384))`;
  if(path.endsWith('/logout'))await sql`SELECT token_hash FROM board_private.sessions WHERE token_hash=${options.sessionTokenHash} FOR UPDATE`;
  else if(path.endsWith('/link'))await sql`SELECT token_hash FROM board_private.sessions WHERE token_hash=${options.sessionTokenHash} FOR SHARE`;
  const before=await loadAccount(sql,options),after=structuredClone(before);
  const result=await fn(after);await persist(sql,before,after,{allocateActivity:true});
  return {result,workspaceId:path==='/api/auth/google'&&after.workspaces.length>before.workspaces.length?after.workspaces.at(-1)?.id:null};
}

export function createPostgresStore(connectionString, { sharedRuntime = process.env.CREWYARD_SHARED_RUNTIME === '1', fineWrites = process.env.CREWYARD_FINE_GRAINED_WRITES === '1' } = {}) {
  // Local disposable PostgreSQL can opt out of TLS explicitly; hosted DBs use TLS.
  const ssl = new URL(connectionString).searchParams.get('sslmode') === 'disable' ? false : 'require';
  const poolSize=Number(process.env.CREWYARD_DB_POOL_SIZE||6);
  if(!Number.isSafeInteger(poolSize)||poolSize<1||poolSize>50)throw new Error('Invalid CREWYARD_DB_POOL_SIZE (1–50)');
  const sql = postgres(connectionString, { max:poolSize, prepare:false, ssl });
  const metrics=createStorageMetrics();
  const limits={...defaultLimits};
  const configured={workspaceRequests:'CREWYARD_WORKSPACE_RPM',workspaceWrites:'CREWYARD_WORKSPACE_WRITE_RPM',actorRequests:'CREWYARD_ACTOR_RPM',actorWrites:'CREWYARD_ACTOR_WRITE_RPM',workspaceDailyResponseBytes:'CREWYARD_WORKSPACE_DAILY_RESPONSE_BYTES',platformDailyResponseBytes:'CREWYARD_PLATFORM_DAILY_RESPONSE_BYTES'};
  for(const [key,env]of Object.entries(configured))if(process.env[env]){
    const value=Number(process.env[env]);if(!Number.isSafeInteger(value)||value<1)throw new Error('Invalid traffic limit '+env);limits[key]=value;
  }
  const budgetLimiter=createBudgetLimiter(sql,{limits});
  const cleanup=sharedRuntime?setInterval(()=>void sql`DELETE FROM board_private.request_budgets WHERE bucket_start < now()-interval '2 days'`.catch(error=>console.error('Budget cleanup failed:',error.code||'unknown')),3600000):null;
  cleanup?.unref();
  return {
    sharedRuntime, fineWrites,
    close: () => { if(cleanup)clearInterval(cleanup);return sql.end(); },
    storageMetrics: ()=>metrics.snapshot(),
    requestWorkspace: async ({actor,path}) => {
      const jobId=path.match(/^\/api\/jobs\/([^/]+)/)?.[1]||null;
      const goalId=path.match(/^\/api\/goals\/([^/]+)/)?.[1]||null;
      const meetingId=path.match(/^\/api\/meetings\/([^/]+)/)?.[1]||null;
      const projectId=path.match(/^\/api\/projects\/([^/]+)/)?.[1]||null;
      if(!jobId&&!goalId&&!meetingId&&!projectId&&!path.match(/^\/api\/workspaces\/[^/]+/)){
        const spaces=await sql`SELECT id FROM board_private.workspaces WHERE owner_id=${actor.id} ORDER BY id LIMIT 1`;
        return spaces[0]?.id||null;
      }
      return mutationWorkspace(sql,{actor,path,jobId,goalId,meetingId,projectId});
    },
    operationWorkspace: args => mutationWorkspace(sql, { ...args, ...writeScopeFor(args.path, args.actor, args, args.input) }),
    consumeBudget: args => sharedRuntime ? budgetLimiter.consume(args) : Promise.resolve(),
    ownerVersion: ownerId => sql`SELECT coalesce(sum(s.revision),0) AS revision FROM board_private.workspace_signals s JOIN board_private.workspaces w ON w.id=s.workspace_id WHERE w.owner_id=${ownerId}`.then(rows=>String(rows[0]?.revision||0)),
    workspaceVersion: workspaceId => sharedRuntime ? sql`SELECT revision FROM board_private.workspace_signals WHERE workspace_id=${workspaceId}`.then(rows=>String(rows[0]?.revision||0)) : Promise.resolve('0'),
    health: async () => {
      if(sharedRuntime){await sql`SELECT revision FROM board_private.workspace_signals LIMIT 0`;await sql`SELECT scope_key FROM board_private.request_budgets LIMIT 0`;}
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
    meetingVersion: ({ actor, meetingId, agentTokenHash, sessionTokenHash }) => sql.begin(async tx => {
      await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
      await assertActorActive(tx, { actor, agentTokenHash, sessionTokenHash });
      const rows = actor.kind === 'user'
        ? await tx`SELECT m.updated_at FROM board_private.meetings m JOIN board_private.workspaces w ON w.id = m.workspace_id WHERE m.id = ${meetingId} AND w.owner_id = ${actor.id}`
        : await tx`SELECT m.updated_at FROM board_private.meetings m WHERE m.id = ${meetingId} AND m.workspace_id = ${actor.workspaceId} AND (m.participant_ids @> ${tx.json([actor.id])}::jsonb OR EXISTS (SELECT 1 FROM board_private.agents a WHERE a.id = ${actor.id} AND a.can_manage = true AND a.revoked_at IS NULL))`;
      if (!rows.length) { const error = new Error('Meeting not found'); error.status = 404; throw error; }
      return stamp(rows[0].updated_at);
    }),
    listMentions: ({ actor, since = null, unreadOnly = false, agentTokenHash, sessionTokenHash }) => sql.begin(async tx => {
      await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
      await assertActorActive(tx, { actor, agentTokenHash, sessionTokenHash });
      const sinceTime = since && !Number.isNaN(Date.parse(since)) ? new Date(since).toISOString() : null;
      const count = await tx`SELECT count(*)::integer AS unread FROM board_private.mentions WHERE recipient_type = ${actor.kind} AND recipient_id = ${actor.id} AND read_at IS NULL`;
      const records = unreadOnly
        ? await tx`SELECT * FROM board_private.mentions WHERE recipient_type = ${actor.kind} AND recipient_id = ${actor.id} AND read_at IS NULL AND (${sinceTime}::timestamptz IS NULL OR created_at > ${sinceTime}::timestamptz) ORDER BY created_at, id LIMIT 100`
        : await tx`SELECT * FROM board_private.mentions WHERE recipient_type = ${actor.kind} AND recipient_id = ${actor.id} ORDER BY created_at DESC, id DESC LIMIT 100`;
      return { unread: count[0].unread, mentions: records.map(row => decode('mentions', row)) };
    }),
    markMentionsRead: ({ actor, ids = null, readAt = new Date().toISOString(), agentTokenHash, sessionTokenHash }) => sql.begin(async tx => {
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
      return fn(await (options.selectedTables ? loadScoped(tx, {...options,onRows:(table,rows)=>{metrics.record(options.workspaceId||options.actor.workspaceId||'owner:'+options.actor.id,table,rows);options.onRows?.(table,rows);}}) : options.path?.startsWith('/api/auth/') ? loadAccount(tx,{...options,onRows:(table,rows)=>metrics.record('account',table,rows)}) : load(tx, options)));
    }),
    write: (fn, options = {}) => retryAccountWrite(()=>sql.begin(async tx => {
      if(!options.actor&&options.path){
        const {result,workspaceId}=await accountTransaction(tx,fn,options,fineWrites);
        if(sharedRuntime&&workspaceId)await tx`INSERT INTO board_private.workspace_signals (workspace_id,revision) VALUES (${workspaceId},1) ON CONFLICT (workspace_id) DO UPDATE SET revision=workspace_signals.revision+1,updated_at=now()`;
        return result;
      }
      if (!options.actor) {
        // Explicit internal fixture/maintenance calls retain compatibility.
        await tx`SELECT pg_advisory_xact_lock(1549452384, 1)`;
        const before = await load(tx, { omitHeavy: true });
        const after = structuredClone(before);
        const result = await fn(after);
        await persist(tx, before, after, { allocateActivity: true });
        return result;
      }
      // The first rollout keeps the old global lock as a compatibility fence.
      // Enable granular writes only after every server runs this implementation.
      if(!fineWrites)await tx`SELECT pg_advisory_xact_lock(1549452384,1)`;
      const scope = writeScopeFor(options.path, options.actor, options, options.input);
      scope.workspaceId = await mutationWorkspace(tx, scope);
      await lockMutation(tx,scope);
      const before = await loadScoped(tx, {...scope,onRows:(table,rows)=>metrics.record(scope.workspaceId,table,rows)});
      const after = structuredClone(before);
      const result = await fn(after);
      await persist(tx, before, after, { allocateActivity: true });
      if(sharedRuntime)await tx`INSERT INTO board_private.workspace_signals (workspace_id,revision) VALUES (${scope.workspaceId},1) ON CONFLICT (workspace_id) DO UPDATE SET revision=workspace_signals.revision+1,updated_at=now()`;
      return result;
    }),options.path),
  };
}
