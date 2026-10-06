// Explicit dependencies for common reads. Unknown routes retain the old loader.
const auth = ['users', 'sessions', 'agents', 'workspaces'];
const project = ['projects', 'project_work_locations'];
const history = ['job_runs', 'job_submissions', 'job_review_decisions'];
const board = [...project, 'jobs', 'goals', 'folders', ...history];
const meetings = ['meetings', 'meeting_rounds', 'meeting_responses', 'meeting_votes', 'meeting_memories'];
export function readScopeFor(path, method, actor, credentials) {
  if (method !== 'GET') return null;
  let selected;
  if (path === '/api/auth/me' || path === '/api/workspaces') selected = [];
  else if (/^\/api\/workspaces\/[^/]+\/people$/.test(path)) selected = [];
  else if (/^\/api\/workspaces\/[^/]+\/announcements$/.test(path)) selected = ['announcements'];
  else if (/^\/api\/workspaces\/[^/]+\/coordination-roster$/.test(path)) selected = ['projects', 'jobs'];
  else if (/^\/api\/workspaces\/[^/]+\/meetings$/.test(path)) selected = ['meetings'];
  else if (/^\/api\/meetings\/[^/]+(?:\/wait)?$/.test(path) || path === '/api/meeting-memory') selected = meetings;
  else if (/^\/api\/workspaces\/[^/]+\/projects$/.test(path) || /^\/api\/projects\/[^/]+$/.test(path)) selected = board;
  else if (/^\/api\/projects\/[^/]+\/needs-you$/.test(path)) selected = [...project, 'jobs', 'job_requests', ...history];
  else if (/^\/api\/projects\/[^/]+\/scope-proposals(?:\/[^/]+)?$/.test(path)) selected = ['projects', 'scope_proposals'];
  else if (/^\/api\/projects\/[^/]+\/agent-invites$/.test(path)) selected = ['projects', 'agent_invites', 'agent_invite_redemptions'];
  else if (/^\/api\/projects\/[^/]+\/goals$/.test(path)) selected = ['projects', 'goals'];
  else if (/^\/api\/projects\/[^/]+\/folders$/.test(path)) selected = ['projects', 'folders'];
  else if (/^\/api\/projects\/[^/]+\/jobs$/.test(path)) selected = ['projects', 'jobs', ...history];
  else if (/^\/api\/projects\/[^/]+\/review-queue$/.test(path)) selected = [...project, 'jobs', 'job_requests', 'comments', 'votes', ...history];
  else if (/^\/api\/jobs\/[^/]+$/.test(path)) selected = [...project, 'jobs', 'job_requests', 'comments', 'votes', ...history];
  else if (/^\/api\/goals\/[^/]+$/.test(path)) selected = ['projects', 'goals', 'jobs', 'comments', ...history];
  else return null;
  return { selectedTables: [...new Set([...auth, ...selected])], actor, ...credentials,
    jobId: path.match(/^\/api\/jobs\/([^/]+)$/)?.[1] || null,
    goalId: path.match(/^\/api\/goals\/([^/]+)$/)?.[1] || null };
}
