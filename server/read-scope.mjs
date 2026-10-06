// Explicit dependencies for common reads. Unknown routes retain the old loader.
const auth = actor => actor.kind==='agent'?['agents','workspaces']:['users','sessions','workspaces'];
const project = ['projects', 'project_work_locations'];
const history = ['job_runs', 'job_submissions', 'job_review_decisions'];
const board = [...project, 'jobs', 'goals', 'folders'];
const meetings = ['meetings', 'meeting_rounds', 'meeting_responses', 'meeting_votes', 'meeting_memories'];
export function readScopeFor(path, method, actor, credentials) {
  if (method !== 'GET') return null;
  let selected;
  if (path === '/api/auth/me' || path === '/api/workspaces') selected = [];
  else if (/^\/api\/workspaces\/[^/]+\/agents$/.test(path)) selected = ['agents','projects'];
  else if (/^\/api\/workspaces\/[^/]+\/people$/.test(path)) selected = ['users','agents'];
  else if (/^\/api\/workspaces\/[^/]+\/announcements$/.test(path)) selected = ['announcements'];
  else if (/^\/api\/workspaces\/[^/]+\/coordination-roster$/.test(path)) selected = ['projects', 'jobs','agents'];
  else if (/^\/api\/workspaces\/[^/]+\/meetings$/.test(path)) selected = ['meetings','agents'];
  else if (path === '/api/meeting-memory') selected = ['meeting_memories'];
  else if (/^\/api\/meetings\/[^/]+(?:\/wait|\/rounds\/page)?$/.test(path)) selected = [...meetings,'agents'];
  else if (/^\/api\/workspaces\/[^/]+\/projects$/.test(path) || /^\/api\/projects\/[^/]+$/.test(path)) selected = board;
  else if (/^\/api\/projects\/[^/]+\/needs-you$/.test(path)) selected = [...project, 'jobs', 'job_requests'];
  else if (/^\/api\/projects\/[^/]+\/scope-proposals(?:\/[^/]+)?$/.test(path)) selected = ['projects', 'scope_proposals'];
  else if (/^\/api\/projects\/[^/]+\/agent-invites$/.test(path)) selected = ['projects', 'agent_invites', 'agent_invite_redemptions'];
  else if (/^\/api\/projects\/[^/]+\/goals$/.test(path)) selected = ['projects', 'goals'];
  else if (/^\/api\/projects\/[^/]+\/folders$/.test(path)) selected = ['projects', 'folders'];
  else if (/^\/api\/projects\/[^/]+\/jobs$/.test(path)) selected = ['projects', 'jobs'];
  else if (/^\/api\/projects\/[^/]+\/review-queue$/.test(path)) selected = [...project, 'jobs', 'job_requests', 'comments', ...history];
  else if (/^\/api\/jobs\/[^/]+\/history\/page$/.test(path)) selected = [...project,'jobs',...history];
  else if (/^\/api\/jobs\/[^/]+$/.test(path)) selected = [...project, 'jobs', 'job_requests', 'comments', 'votes', ...history];
  else if (/^\/api\/goals\/[^/]+$/.test(path)) selected = ['projects', 'goals', 'jobs', 'comments'];
  else if (/^\/api\/projects\/[^/]+\/jobs\/page$/.test(path)) selected=['projects','jobs'];
  else if (/^\/api\/jobs\/[^/]+\/comments\/page$/.test(path)) selected=['projects','jobs','comments'];
  else if (/^\/api\/goals\/[^/]+\/comments\/page$/.test(path)) selected=['projects','goals','comments'];
  else return null;
  return { selectedTables: [...new Set([...auth(actor), ...selected])], actor, ...credentials,
    reviewQueue:path.endsWith('/review-queue'),
    meetingId:path.match(/^\/api\/meetings\/([^/]+)/)?.[1]||null,
    memoryHistory:actor.kind==='agent'&&(path==='/api/meeting-memory'||/^\/api\/meetings\/[^/]+(?:\/wait)?$/.test(path)),
    jobSummary: selected.includes('jobs') && !/^\/api\/jobs\/[^/]+$/.test(path) && !path.endsWith('/review-queue') && !path.endsWith('/history/page'),
    workspaceId:path.match(/^\/api\/workspaces\/([^/]+)/)?.[1]||null,
    projectId:path.match(/^\/api\/projects\/([^/]+)/)?.[1]||null,
    fullRoster: path.endsWith('/agents') || path.endsWith('/people') || path.endsWith('/coordination-roster') || path.includes('/meetings'),
    workspaceWide: path.endsWith('/coordination-roster') && actor.canManage,
    jobId: path.match(/^\/api\/jobs\/([^/]+)(?:\/comments\/page|\/history\/page)?$/)?.[1] || null,
    goalId: path.match(/^\/api\/goals\/([^/]+)(?:\/comments\/page)?$/)?.[1] || null };
}
