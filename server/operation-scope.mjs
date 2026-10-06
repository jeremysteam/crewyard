const auth=actor=>['users','workspaces','projects',...(actor.kind==='agent'?['agents']:['sessions'])];
const history=['job_runs','job_submissions','job_review_decisions'];
const board=['project_work_locations','jobs','goals','folders',...history];
const coordination=['meetings','meeting_rounds','meeting_responses','meeting_votes','meeting_memories'];

// Mutations hydrate only the entity graph used by that operation. Append-only
// event rows start empty on both sides of the diff, preserving older records.
export function writeScopeFor(path,actor,credentials,input={}){
  let selected=[];
  const jobId=path.match(/^\/api\/jobs\/([^/]+)/)?.[1]||null;
  const goalId=path.match(/^\/api\/goals\/([^/]+)/)?.[1]||null;
  const meetingId=path.match(/^\/api\/meetings\/([^/]+)/)?.[1]||null;
  const projectId=path.match(/^\/api\/projects\/([^/]+)/)?.[1]||null;
  const announcementId=path.match(/^\/api\/workspaces\/[^/]+\/announcements\/([^/]+)/)?.[1]||null;
  if(jobId)selected=['jobs','job_requests',...history,...(path.endsWith('/votes')?['votes']:[])];
  else if(goalId)selected=['goals'];
  else if(path==='/api/meeting-memory')selected=['meeting_memories'];
  else if(meetingId)selected=coordination;
  else if(path.includes('/announcements'))selected=['announcements',...(input.kind==='assignment'?['jobs',...history]:[])];
  else if(path.includes('/meetings'))selected=['meeting_memories'];
  else if(projectId){
    if(path.includes('/scope-proposals'))selected=['scope_proposals'];
    else if(path.includes('/agent-invites'))selected=['agent_invites','agent_invite_redemptions'];
    else if(path.includes('/folder-pairings'))selected=['folder_pairings'];
    else if(path.includes('/folders'))selected=['folders'];
    else if(path.endsWith('/goals'))selected=[];
    else if(path.endsWith('/jobs'))selected=['goals'];
    else selected=board;
  } else if(/\/workspaces\/[^/]+\/(agents|projects)/.test(path))selected=[];
  else throw Object.assign(new Error('No mutation scope for this endpoint'),{status:404});
  const fullRoster=path.includes('/announcements')||/^\/api\/workspaces\/[^/]+\/agents/.test(path)||path.includes('/meetings')||path.includes('/agent-invites')||path.endsWith('/comments')||path.endsWith('/move');
  return {actor,...credentials,fullRoster,selectedTables:[...new Set([...auth(actor),...(fullRoster?['agents']:[]),...selected])],
    writeMode:true,jobId:jobId||(input.kind==='assignment'?input.jobId:null),goalId,
    requestId:path.match(/^\/api\/jobs\/[^/]+\/requests\/([^/]+)/)?.[1]||null,meetingId,targetRoundId:path.match(/^\/api\/meetings\/[^/]+\/rounds\/([^/]+)/)?.[1]||null,projectId,announcementId,workspaceWide:/\/announcements/.test(path),
    appendOnly:new Set(['comments','mentions','activity',...(!announcementId?['announcements']:[])]),path,input};
}
