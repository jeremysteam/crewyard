import { createServer } from 'node:http';
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { OAuth2Client } from 'google-auth-library';
import { createStore } from './store.mjs';
import { readScopeFor } from './read-scope.mjs';
import { createWaitHub } from './wait-hub.mjs';
import { decodeCursor, page } from './pagination.mjs';

const scrypt = promisify(scryptCallback);
const day = 86_400_000;
const statuses = ['idea', 'working', 'review', 'completed'];
const allowedMoves = { idea: ['working'], working: ['idea', 'review'], review: ['working', 'completed'], completed: ['review'] };
const fail = (status, message) => { const error = new Error(message); error.status = status; throw error; };
const id = () => randomUUID();
const hash = (value) => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const token = () => randomBytes(32).toString('base64url');
const googleVerifier = new OAuth2Client();
const nameOk = (name) => /^[a-zA-Z][a-zA-Z0-9_-]{1,31}$/.test(name);
const inviteOk = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const workLocationKinds = ['folder', 'link'];
const text = (value, field, max = 4000) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(400, `${field} is required (max ${max} characters)`);
  return value.trim();
};
const emptyBrief = () => ({ purpose: '', workContext: '', constraints: '', definitionOfDone: '' });
function optionalText(value, field, max) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.trim().length > max || /[\x00-\x1f\x7f]/.test(value)) fail(400, `${field} must be text without control characters (max ${max})`);
  return value.trim();
}
function startingPointInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Starting point must be an object');
  return { branch: optionalText(value.branch, 'Branch', 255), commit: optionalText(value.commit, 'Commit', 64), worktree: optionalText(value.worktree, 'Worktree', 2048) };
}
function reviewEvidenceInput(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Review evidence must be an object');
  const list = (items, field, parse) => {
    if (items === undefined) return [];
    if (!Array.isArray(items) || items.length > 20) fail(400, `${field} must contain at most 20 entries`);
    return items.map(item => { if (!item || typeof item !== 'object' || Array.isArray(item)) fail(400, `Invalid ${field} entry`); return parse(item); });
  };
  return {
    artifacts: list(value.artifacts, 'Artifacts', item => ({ label: text(item.label, 'Artifact label', 160), target: text(item.target, 'Artifact target', 2048) })),
    checks: list(value.checks, 'Checks', item => {
      if (!['passed', 'failed', 'not_run'].includes(item.result)) fail(400, 'Check result must be passed, failed, or not_run');
      return { name: text(item.name, 'Check name', 160), result: item.result, detail: item.detail === undefined ? '' : typeof item.detail === 'string' && item.detail.length <= 4000 ? item.detail.trim() : fail(400, 'Check detail must be text (max 4000)') };
    }),
    notes: value.notes === undefined ? '' : typeof value.notes === 'string' && value.notes.length <= 4000 ? value.notes.trim() : fail(400, 'Evidence notes must be text (max 4000)'),
  };
}
function readBrief(value) {
  const brief = emptyBrief();
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const field of Object.keys(brief)) if (typeof value[field] === 'string') brief[field] = value[field];
  }
  return brief;
}
function briefInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Brief must be an object');
  const brief = emptyBrief();
  for (const field of Object.keys(brief)) {
    if (typeof value[field] !== 'string' || value[field].trim().length > 4000) fail(400, `${field} must be text (max 4000 characters)`);
    brief[field] = value[field].trim();
  }
  return brief;
}
function scopeInput(value) {
  const brief = briefInput(value?.brief);
  const plan = value?.plan === undefined ? '' : value.plan;
  if (typeof plan !== 'string' || plan.trim().length > 8000) fail(400, 'Plan must be text (max 8000 characters)');
  if (!Object.values(brief).some(Boolean) && !plan.trim()) fail(400, 'Add a brief or plan');
  return { brief, plan: plan.trim() };
}
function scopeFingerprint(p) { return hash(JSON.stringify({ brief: readBrief(p.brief), plan: p.scopePlan || '' })); }
function workLocationInput(value) {
  const label = text(value?.label, 'Label', 80);
  const target = text(value?.target, 'Location', 2048);
  if (!workLocationKinds.includes(value?.kind)) fail(400, 'Choose a folder path or link');
  if (/[\x00-\x1f\x7f]/.test(label + target)) fail(400, 'Control characters are not allowed');
  if (value.kind === 'link') {
    let url;
    try { url = new URL(target); } catch { fail(400, 'Use a full HTTPS link'); }
    if (url.protocol !== 'https:' || url.username || url.password) fail(400, 'Use a full HTTPS link without credentials');
  }
  return { label, kind: value.kind, target };
}
const publicUser = (user) => ({ id: user.id, name: user.name, handle: user.handle, email: user.email });
const sessionCookie = (req, value) => `sid=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${req.socket.encrypted || process.env.RENDER ? '; Secure' : ''}`;
const googleNonceCookie = (req, value, age) => `gnonce=${value}; HttpOnly; SameSite=Lax; Path=/api/auth/google; Max-Age=${age}${req.socket.encrypted || process.env.RENDER ? '; Secure' : ''}`;
const actorRef = (actor) => ({ type: actor.kind, id: actor.id, name: actor.name, handle: actor.handle });
const sameActor = (a, b) => !!a && a.type === b.kind && a.id === b.id;

async function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  const key = await scrypt(password, salt, 64);
  return `${salt}:${key.toString('hex')}`;
}
async function verifyPassword(password, stored) {
  const [salt, expected] = stored.split(':');
  const actual = await scrypt(password, salt, 64);
  const expectedBytes = Buffer.from(expected, 'hex');
  return actual.length === expectedBytes.length && timingSafeEqual(actual, expectedBytes);
}
function cookie(req, key) {
  return req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith(`${key}=`))?.slice(key.length + 1);
}
async function send(res, status, value, headers = {}) {
  const encoded=JSON.stringify(value,(key,item)=>key==='_ordinal'?undefined:item);
  const bytes=Buffer.byteLength(encoded);
  if(status<400 && bytes>4*1024*1024)fail(413,'Response exceeds 4 MiB. Use the paginated endpoint.');
  if(status<400 && res.chargeTraffic)await res.chargeTraffic(bytes);
  if(res.destroyed)return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(encoded);
}
async function body(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 1024 * 1024) fail(413, 'Request too large'); }
  try { const parsed = raw ? JSON.parse(raw) : {}; req.boardInput = parsed; return parsed; } catch { fail(400, 'Invalid JSON'); }
}
function actorFor(db, req) {
  if (req.headers.authorization !== undefined) {
    const bearer = req.headers.authorization.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
    if (!bearer) return null;
    const agent = db.agents.find(a => a.tokenHash === hash(bearer) && !a.revokedAt);
    return agent?.rootProjectId ? { kind: 'agent', id: agent.id, name: agent.name, handle: agent.name, workspaceId: agent.workspaceId, rootProjectId: agent.rootProjectId, canReview: agent.canReview === true, canManage: agent.canManage === true } : null;
  }
  const sessionToken = cookie(req, 'sid');
  const session = sessionToken && db.sessions.find(s => s.tokenHash === hash(sessionToken) && Date.parse(s.expiresAt) > Date.now());
  const user = session && db.users.find(u => u.id === session.userId);
  return user ? { kind: 'user', id: user.id, name: user.name, handle: user.handle } : null;
}
function credentialHashes(req) {
  if (req.headers.authorization !== undefined) {
    const bearer = req.headers.authorization.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
    return { agentTokenHash: bearer ? hash(bearer) : null, sessionTokenHash: null };
  }
  const sessionToken = cookie(req, 'sid');
  return { agentTokenHash: null, sessionTokenHash: sessionToken ? hash(sessionToken) : null };
}
function requireActor(db, req) { const actor = actorFor(db, req); if (!actor) fail(401, 'Sign in or connect an agent'); return actor; }
function workspace(db, actor, workspaceId) {
  const found = db.workspaces.find(w => w.id === workspaceId);
  if (!found || (actor.kind === 'user' ? found.ownerId !== actor.id : actor.workspaceId !== found.id)) fail(404, 'Workspace not found');
  return found;
}
function project(db, actor, projectId) {
  const found = db.projects.find(p => p.id === projectId);
  if (!found) fail(404, 'Project not found');
  workspace(db, actor, found.workspaceId);
  if (actor.kind === 'agent' && (found.parentProjectId || found.id) !== actor.rootProjectId) fail(404, 'Project not found');
  return found;
}
function rootProject(db, p) { return p.parentProjectId ? db.projects.find(parent => parent.id === p.parentProjectId) : p; }
function visibleProject(db, actor, p) { return actor.kind === 'user' || (p.parentProjectId || p.id) === actor.rootProjectId; }
function goal(db, actor, goalId) {
  const found = db.goals.find(g => g.id === goalId);
  if (!found) fail(404, 'Goal not found');
  project(db, actor, found.projectId);
  return found;
}
function job(db, actor, jobId) {
  const found = db.jobs.find(j => j.id === jobId);
  if (!found) fail(404, 'Job not found');
  project(db, actor, found.projectId);
  return found;
}
function event(db, actor, projectId, action, detail, goalId = null, jobId = null) {
  db.activity.push({ id: db.nextActivityId++, projectId, goalId, jobId, actor: actorRef(actor), action, detail, createdAt: now() });
}
function issueAgent(db, { workspaceId, rootProjectId, name, credential, inviteId = null }) {
  // Both enrollment paths meet here so a future workspace plan limit can be enforced once.
  const agent = { id: id(), workspaceId, rootProjectId, name, tokenHash: hash(credential), inviteId, canReview: false, canManage: false, createdAt: now(), revokedAt: null };
  db.agents.push(agent);
  return agent;
}
function addMentions(db, actor, workspaceId, bodyText, commentId, projectId, goalId, jobId) {
  const names = new Set([...bodyText.matchAll(/@([a-zA-Z][a-zA-Z0-9_-]{1,31})/g)].map(m => m[1].toLowerCase()));
  const mentionRootId = rootProject(db, db.projects.find(p => p.id === projectId))?.id;
  const recipients = [
    ...db.agents.filter(a => a.workspaceId === workspaceId && !a.revokedAt && a.rootProjectId === mentionRootId).map(a => ({ kind: 'agent', id: a.id, handle: a.name })),
    ...db.users.filter(u => db.workspaces.some(w => w.id === workspaceId && w.ownerId === u.id)).map(u => ({ kind: 'user', id: u.id, handle: u.handle })),
  ];
  for (const recipient of recipients) {
    if (!names.has(recipient.handle.toLowerCase()) || sameActor({ type: recipient.kind, id: recipient.id }, actor)) continue;
    db.mentions.push({ id: id(), recipientType: recipient.kind, recipientId: recipient.id, commentId, projectId, goalId, jobId, from: actorRef(actor), readAt: null, createdAt: now() });
  }
}
function csrf(req, actor) {
  if (actor.kind !== 'user' || ['GET', 'HEAD'].includes(req.method)) return;
  const origin = req.headers.origin;
  const allowed = [req.headers.host, process.env.APP_ORIGIN && new URL(process.env.APP_ORIGIN).host].filter(Boolean);
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { fail(403, 'Invalid request origin'); }
    if (!allowed.includes(host)) fail(403, 'Invalid request origin');
  }
}
function projectView(db, p) {
  const jobs = db.jobs.filter(j => j.projectId === p.id);
  const children = db.projects.filter(child => child.parentProjectId === p.id);
  const branchIds = new Set([p.id, ...children.map(child => child.id)]);
  const branchJobs = db.jobs.filter(j => branchIds.has(j.projectId));
  const counts = items => Object.fromEntries(statuses.map(s => [s, items.filter(j => j.status === s).length]));
  const projectCounts=id=>db.jobCounts?Object.fromEntries(statuses.map(s=>[s,db.jobCounts[id+':'+s]||0])):counts(db.jobs.filter(j=>j.projectId===id));
  const reviewInstructions = p.reviewInstructions || (p.parentProjectId ? db.projects.find(parent => parent.id === p.parentProjectId)?.reviewInstructions : '') || '';
  return { ...p, brief: readBrief(p.brief), scopePlan: p.scopePlan || '', reviewInstructions, workLocations: Array.isArray(p.workLocations) ? p.workLocations : [], parentProjectId: p.parentProjectId || null, goals: db.goals.filter(g => g.projectId === p.id), jobs, folders: db.folders.filter(f => f.projectId === p.id), jobsTruncated:!!db.jobsTruncated, counts: projectCounts(p.id), rollupCounts: db.jobCounts?Object.fromEntries(statuses.map(s=>[s,[...branchIds].reduce((sum,id)=>sum+(db.jobCounts[id+':'+s]||0),0)])):counts(branchJobs), childProjects: children.map(child => ({ id: child.id, name: child.name, description: child.description, counts: projectCounts(child.id) })) };
}
function jobView(db, j) {
  const ownProject = db.projects.find(p => p.id === j.projectId);
  const ownLocations = Array.isArray(ownProject?.workLocations) ? ownProject.workLocations : [];
  const parent = ownProject?.parentProjectId ? db.projects.find(p => p.id === ownProject.parentProjectId && p.workspaceId === ownProject.workspaceId) : null;
  const source = ownLocations.length ? ownProject : parent || ownProject;
  const workLocations = (Array.isArray(source?.workLocations) ? source.workLocations : []).map(location => ({
    ...location, sourceProjectId: source.id, sourceProjectName: source.name, inherited: source.id !== j.projectId,
  }));
  return { ...j, runs:(j.runs||[]).slice(-20), submissionHistory:(j.submissionHistory||[]).slice(-20), reviewHistory:(j.reviewHistory||[]).slice(-20), workLocations, requests: db.jobRequests.filter(r => r.jobId === j.id), comments: db.comments.filter(c => c.jobId === j.id).slice(-50), commentsPage: commentPage(db.comments.filter(c=>c.jobId===j.id)), votes: db.votes.filter(v => v.jobId === j.id) };
}
function commentPage(comments){
  if(comments.length<=50)return {nextCursor:null};
  const oldest=comments.slice(-50)[0];
  return {nextCursor:Buffer.from(JSON.stringify([oldest.createdAt,oldest.id])).toString('base64url')};
}
function needsYouView(db, p) {
  const branchIds = new Set([p.id, ...db.projects.filter(child => child.parentProjectId === p.id).map(child => child.id)]);
  const jobs = db.jobs.filter(j => branchIds.has(j.projectId));
  const item = j => ({ job: j, project: { id: j.projectId, name: db.projects.find(p => p.id === j.projectId).name } });
  const requests = db.jobRequests.filter(r => r.status === 'pending' && jobs.some(j => j.id === r.jobId))
    .map(r => ({ ...item(jobs.find(j => j.id === r.jobId)), request: r }))
    .sort((a, b) => b.request.createdAt.localeCompare(a.request.createdAt));
  const reviews = jobs.filter(j => j.status === 'review').map(item).sort((a, b) => b.job.updatedAt.localeCompare(a.job.updatedAt));
  const completed = jobs.filter(j => j.status === 'completed').map(item).sort((a, b) => b.job.updatedAt.localeCompare(a.job.updatedAt)).slice(0, 20);
  return { requests, reviews, completed };
}

function canManage(actor) { return actor.kind === 'user' || actor.canManage === true; }
function meeting(db, actor, meetingId) {
  const found = db.meetings.find(item => item.id === meetingId);
  if (!found) fail(404, 'Meeting not found');
  workspace(db, actor, found.workspaceId);
  if (actor.kind === 'agent' && !found.participantIds.includes(actor.id) && !canManage(actor)) fail(404, 'Meeting not found');
  return found;
}
function roundView(db, actor, round) {
  const answers = db.meetingResponses.filter(item => item.roundId === round.id);
  const revealed = round.stage === 'synthesis' || round.stage === 'complete';
  return {
    ...round,
    answerCount: answers.filter(item => item.kind === 'answer').length,
    responses: answers.filter(item => revealed || item.agentId === actor.id || round.mode === 'open' && item.kind === 'answer').map(item => ({ ...item })),
    votes: round.stage === 'complete' ? db.meetingVotes.filter(item => item.roundId === round.id) : [],
  };
}
function meetingMemoryView(db, actor) {
  const body = db.meetingMemories.find(item => item.workspaceId === actor.workspaceId && item.agentId === actor.id)?.body || '';
  const history = db.meetingResponses.filter(item => item.agentId === actor.id).slice(-10).map(item => {
    const round = db.meetingRounds.find(entry => entry.id === item.roundId);
    const found = db.meetings.find(entry => entry.id === round?.meetingId && entry.workspaceId === actor.workspaceId);
    return found ? { meetingTitle: found.title, prompt: round.prompt, kind: item.kind, answer: item.body.slice(0, 2000), createdAt: item.createdAt } : null;
  }).filter(Boolean);
  return { body, history:db.agentMemoryHistory||history };
}
function meetingView(db, actor, found) {
  const participants = found.participantIds.map(agentId => db.agents.find(agent => agent.id === agentId))
    .filter(Boolean).map(agent => ({ id: agent.id, name: agent.name, rootProjectId: agent.rootProjectId, revokedAt: agent.revokedAt }));
  return { ...found, participants, rounds: db.meetingRounds.filter(item => item.meetingId === found.id).sort((a,b)=>a.ordinal-b.ordinal).slice(-20).map(item => roundView(db, actor, item)),
    roundsPage: { before:db.meetingRounds.filter(item=>item.meetingId===found.id).length>20 ? db.meetingRounds.filter(item=>item.meetingId===found.id).sort((a,b)=>a.ordinal-b.ordinal).slice(-20)[0].ordinal:null },
    ...(actor.kind === 'agent' ? { myMemory: meetingMemoryView(db, actor) } : {}) };
}
function beginRound(db, found, { prompt, mode, targetAgentId = null }) {
  if (!['open', 'blind', 'targeted'].includes(mode)) fail(400, 'Invalid round mode');
  if (mode === 'targeted' && !found.participantIds.includes(targetAgentId)) fail(400, 'Choose a meeting participant');
  if (mode !== 'targeted' && targetAgentId) fail(400, 'Target is only valid in a targeted round');
  if (db.meetingRounds.some(item => item.meetingId === found.id && item.stage !== 'complete')) fail(409, 'Finish the current round first');
  const round = { id: id(), meetingId: found.id, ordinal: db.meetingRounds.filter(item => item.meetingId === found.id).reduce((max,item)=>Math.max(max,item.ordinal),0) + 1,
    prompt, mode, targetAgentId, participantIds: mode === 'targeted' ? [targetAgentId] : [...found.participantIds],
    mainAgentId: found.mainAgentId, stage: mode === 'targeted' ? 'target' : 'answers', createdAt: now(), completedAt: null };
  db.meetingRounds.push(round);
  return round;
}
function progressRound(db, found, round) {
  const answered = agentId => db.meetingResponses.some(item => item.roundId === round.id && item.agentId === agentId && item.kind === 'answer');
  if (round.mode === 'targeted' && answered(round.targetAgentId)) round.stage = 'complete';
  if (round.mode === 'open' && round.stage === 'answers' && round.participantIds.filter(agentId => agentId !== round.mainAgentId).every(answered)) round.stage = 'main';
  if (round.mode === 'blind' && round.stage === 'answers' && round.participantIds.every(answered)) round.stage = 'synthesis';
  if (round.stage === 'complete' && !round.completedAt) round.completedAt = now();
}
function maybeAutoAdvance(db, found, round) {
  if (!found.autoMode || round.stage !== 'complete') return;
  if (db.meetingRounds.some(item => item.meetingId === found.id && item.ordinal > round.ordinal)) return;
  const votes = db.meetingVotes.filter(item => item.roundId === round.id);
  if (!round.participantIds.every(agentId => votes.some(vote => vote.agentId === agentId))) return;
  const blind = votes.filter(vote => vote.mode === 'blind').length > votes.length / 2;
  beginRound(db, found, { prompt: `Continue the discussion on: ${round.prompt}`, mode: blind ? 'blind' : 'open' });
  found.updatedAt = now();
}

export function createApp({ filePath, distDir = null, store: baseStore = createStore(filePath), googleClientId = process.env.GOOGLE_CLIENT_ID || '', verifyGoogleToken = async (credential, audience) => {
  const ticket = await googleVerifier.verifyIdToken({ idToken: credential, audience });
  return ticket.getPayload();
} }) {
  const loginAttempts = new Map();
  const enrollmentAttempts = new Map();
  const waitHub = createWaitHub();
  async function waitForWorkspace(req, res, workspaceId, actor, timeout, revision) {
    const abort=new AbortController();
    const closed=()=>abort.abort();res.once('close',closed);
    try{return await waitHub.wait({key:actor.kind==='user'?'owner:'+actor.id:workspaceId,actor:actor.kind+':'+actor.id,since:revision,
      probe:()=>actor.kind==='user'?baseStore.ownerVersion(actor.id):baseStore.workspaceVersion(workspaceId),timeout,signal:abort.signal});}
    finally{res.off('close',closed);}
  }

  async function api(req, res, url) {
    const path = url.pathname;
    const method = req.method;
    let store = { ...baseStore,
      read:(fn,options={})=>baseStore.read(fn,{...options,path,method,input:req.boardInput||{},account:req.boardScope||{},...credentialHashes(req)}),
      write:(fn,options={})=>baseStore.write(fn,{...options,path,method,input:req.boardInput||{},account:req.boardScope||{},...credentialHashes(req)}),
    };
    if (path === '/api/health' && method === 'GET') {
      if (store.health) await store.health();
      else await store.read(() => true);
      return send(res, 200, { ok: true });
    }

    if (path === '/api/auth/google/config' && method === 'GET') {
      if (!googleClientId) return send(res, 200, { enabled: false });
      const nonce = token();
      return send(res, 200, { enabled: true, clientId: googleClientId, nonce }, {
        'set-cookie': googleNonceCookie(req, nonce, 600),
      });
    }

    if ((path === '/api/auth/google' || path === '/api/auth/google/link') && method === 'POST') {
      if (!googleClientId) fail(404, 'Google sign-in is not configured');
      const expectedOrigin = process.env.APP_ORIGIN || process.env.RENDER_EXTERNAL_URL || `${process.env.RENDER ? 'https' : 'http'}://${req.headers.host}`;
      if (req.headers.origin !== new URL(expectedOrigin).origin) fail(403, 'Invalid request origin');
      const input = await body(req);
      const nonce = cookie(req, 'gnonce');
      if (!nonce || !/^[A-Za-z0-9_-]{43}$/.test(nonce) || typeof input.credential !== 'string' || input.credential.length > 8192) fail(400, 'Start Google sign-in again');
      let claims;
      try { claims = await verifyGoogleToken(input.credential, googleClientId); }
      catch { fail(401, 'Google sign-in could not be verified'); }
      if (!claims || claims.nonce !== nonce || typeof claims.sub !== 'string' || !claims.sub || claims.email_verified !== true || typeof claims.email !== 'string' || !/^\S+@\S+\.\S+$/.test(claims.email)) fail(401, 'Google sign-in could not be verified');
      const email = claims.email.toLowerCase();
      if (email.length > 254 || claims.sub.length > 255) fail(401, 'Google sign-in could not be verified');
      const verifiedName=String(claims.name||email.split('@')[0]||'Google user').replace(/[\x00-\x1f\x7f]/g,'').trim().slice(0,80)||'Google user';
      req.boardScope={subject:claims.sub,email,handle:verifiedName.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,24)||'owner'};
      const identity = db => db.authIdentities.find(item => item.provider === 'google' && item.subject === claims.sub);

      if (path.endsWith('/link')) {
        const value = await store.write(db => {
          const actor = requireActor(db, req);
          csrf(req, actor);
          if (actor.kind !== 'user') fail(403, 'Sign in to link Google');
          const user = db.users.find(item => item.id === actor.id);
          if (user.email !== email) fail(409, 'Use the Google account with this CrewYard email');
          const existing = identity(db);
          if (existing && existing.userId !== user.id) fail(409, 'Google account is linked elsewhere');
          if (!existing && db.authIdentities.some(item => item.userId === user.id && item.provider === 'google')) fail(409, 'This CrewYard account already has Google sign-in');
          if (!existing) db.authIdentities.push({ id: id(), userId: user.id, provider: 'google', subject: claims.sub, emailAtLink: email, createdAt: now() });
          return { linked: true };
        });
        return send(res, 200, value, { 'set-cookie': googleNonceCookie(req, '', 0) });
      }

      const sessionToken = token();
      const unavailablePassword = await passwordHash(token());
      const value = await store.write(db => {
        let user = identity(db) && db.users.find(item => item.id === identity(db).userId);
        let created = false;
        if (!user) {
          if (db.users.some(item => item.email === email)) fail(409, 'Email already registered. Sign in with your password, then link Google.');
          const name = String(claims.name || email.split('@')[0] || 'Google user').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 80) || 'Google user';
          const baseHandle = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'owner';
          let handle = baseHandle;
          while (db.users.some(item => item.handle === handle)) handle = `${baseHandle.slice(0, 24)}-${randomBytes(2).toString('hex')}`;
          user = { id: id(), name, handle, email, passwordHash: unavailablePassword, createdAt: now() };
          db.users.push(user);
          db.workspaces.push({ id: id(), name: `${name}'s workspace`.slice(0, 80), ownerId: user.id, createdAt: now() });
          db.authIdentities.push({ id: id(), userId: user.id, provider: 'google', subject: claims.sub, emailAtLink: email, createdAt: now() });
          created = true;
        }
        db.sessions.push({ tokenHash: hash(sessionToken), userId: user.id, expiresAt: new Date(Date.now() + 7 * day).toISOString() });
        return { user: publicUser(user), workspaces: db.workspaces.filter(w => w.ownerId === user.id), created };
      });
      return send(res, 200, value, { 'set-cookie': [sessionCookie(req, sessionToken), googleNonceCookie(req, '', 0)] });
    }

    if (path === '/api/auth/register' && method === 'POST') {
      const input = await body(req);
      const name = text(input.name, 'Name', 80);
      const email = text(input.email, 'Email', 254).toLowerCase();
      const password = text(input.password, 'Password', 200);
      const workspaceName = text(input.workspaceName || `${name}'s workspace`, 'Workspace name', 80);
      if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 10) fail(400, 'Use a valid email and a password of at least 10 characters');
      const secured = await passwordHash(password);
      const sessionToken = token();
      const value = await store.write(db => {
        if (db.users.some(u => u.email === email)) fail(409, 'Email already registered');
        let handle = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'owner';
        if (db.users.some(u => u.handle === handle)) handle += `-${randomBytes(2).toString('hex')}`;
        const user = { id: id(), name, handle, email, passwordHash: secured, createdAt: now() };
        const workspace = { id: id(), name: workspaceName, ownerId: user.id, createdAt: now() };
        db.users.push(user); db.workspaces.push(workspace);
        db.sessions.push({ tokenHash: hash(sessionToken), userId: user.id, expiresAt: new Date(Date.now() + 7 * day).toISOString() });
        return { user: publicUser(user), workspaces: [workspace] };
      });
      return send(res, 201, value, { 'set-cookie': sessionCookie(req, sessionToken) });
    }

    if (path === '/api/auth/login' && method === 'POST') {
      const key = req.socket.remoteAddress || 'unknown';
      const attempt = loginAttempts.get(key) || { count: 0, until: 0 };
      if (attempt.count >= 10 && attempt.until > Date.now()) fail(429, 'Too many attempts. Try again later.');
      const input = await body(req);
      const user = await store.read(db => db.users.find(u => u.email === String(input.email || '').toLowerCase()));
      if (!user || !(await verifyPassword(String(input.password || ''), user.passwordHash))) {
        loginAttempts.set(key, { count: attempt.count + 1, until: Date.now() + 15 * 60_000 });
        fail(401, 'Invalid email or password');
      }
      loginAttempts.delete(key);
      req.boardScope={userId:user.id};
      const sessionToken = token();
      const value = await store.write(db => {
        db.sessions.push({ tokenHash: hash(sessionToken), userId: user.id, expiresAt: new Date(Date.now() + 7 * day).toISOString() });
        return { user: publicUser(user), workspaces: db.workspaces.filter(w => w.ownerId === user.id) };
      });
      return send(res, 200, value, { 'set-cookie': sessionCookie(req, sessionToken) });
    }

    if (path === '/api/auth/logout' && method === 'POST') {
      const actor = await store.read(db => actorFor(db, req));
      if (actor) csrf(req, actor);
      const sid = cookie(req, 'sid');
      await store.write(db => { db.sessions = db.sessions.filter(s => s.tokenHash !== hash(sid || '')); });
      return send(res, 200, { ok: true }, { 'set-cookie': 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
    }

    if (path === '/api/agent-enrollments' && method === 'POST') {
      if (url.search) fail(400, 'Do not put enrollment secrets in the URL');
      const address = req.socket.remoteAddress || 'unknown';
      const previous = enrollmentAttempts.get(address);
      const current = previous?.until > Date.now() ? previous : { count: 0, until: 0 };
      if (current.count >= 10 && current.until > Date.now()) fail(429, 'Too many enrollment attempts. Try again later.');
      const origin = req.headers.origin;
      if (origin) {
        let requestOrigin;
        try { requestOrigin = new URL(origin).origin; } catch { fail(403, 'Invalid request origin'); }
        const serverOrigin = `${req.socket.encrypted || process.env.RENDER ? 'https' : 'http'}://${req.headers.host}`;
        if (![serverOrigin, process.env.APP_ORIGIN || process.env.RENDER_EXTERNAL_URL].filter(Boolean).includes(requestOrigin)) fail(403, 'Invalid request origin');
      }
      const input = await body(req);
      const secret = input.invite;
      const requestedName = input.name === undefined ? null : text(input.name, 'Agent name', 32);
      if (requestedName && !nameOk(requestedName)) fail(400, 'Use 2–32 letters, numbers, hyphens or underscores; start with a letter');
      try {
        if (!inviteOk(secret)) fail(401, 'Invalid or unavailable invite');
        const credential = token();
        const value = await store.write(db => {
          const invite = db.agentInvites.find(entry => entry.secretHash === hash(secret));
          if (!invite || invite.revokedAt || Date.parse(invite.expiresAt) <= Date.now() || invite.useCount >= invite.maxUses) fail(401, 'Invalid or unavailable invite');
          const root = db.projects.find(p => p.id === invite.rootProjectId && p.workspaceId === invite.workspaceId && !p.parentProjectId);
          if (!root) fail(401, 'Invalid or unavailable invite');
          let name = requestedName || `agent-${randomBytes(4).toString('hex')}`;
          const taken = value => db.agents.some(a => a.workspaceId === invite.workspaceId && !a.revokedAt && a.name.toLowerCase() === value.toLowerCase());
          if (taken(name)) {
            const base = name.slice(0, 27);
            do { name = `${base}-${randomBytes(2).toString('hex')}`; } while (taken(name));
          }
          const agent = issueAgent(db, { workspaceId: invite.workspaceId, rootProjectId: invite.rootProjectId, name, credential, inviteId: invite.id });
          invite.useCount += 1;
          invite.redemptions.push({ agentId: agent.id, name, createdAt: agent.createdAt });
          event(db, { kind: 'agent', id: agent.id, name, handle: name }, root.id, 'agent.joined', `${name} joined through an invite`);
          return { agent: { id: agent.id, name, workspaceId: agent.workspaceId, rootProjectId: agent.rootProjectId, createdAt: agent.createdAt }, project: { id: root.id, name: root.name } };
        });
        enrollmentAttempts.delete(address);
        return send(res, 201, { ...value, token: credential });
      } catch (error) {
        if (error.status === 401) enrollmentAttempts.set(address, { count: current.count + 1, until: Date.now() + 15 * 60_000 });
        throw error;
      }
    }

    if (path === '/api/folder-pairings/claim' && method === 'POST') {
      const input = await body(req);
      const code = text(input.code, 'Pairing code', 200);
      const projectId = text(input.projectId, 'Project ID', 100);
      const folderPath = text(input.path, 'Folder path', 2048);
      const machine = text(input.machine, 'Computer name', 120);
      const value = await store.write(db => {
        const pairing = db.folderPairings.find(p => p.codeHash === hash(code) && p.projectId === projectId && !p.usedAt && Date.parse(p.expiresAt) > Date.now());
        if (!pairing) fail(404, 'Pairing code is invalid or expired');
        if (!db.projects.some(p => p.id === projectId)) fail(404, 'Project not found');
        pairing.usedAt = now();
        const existing = db.folders.find(f => f.projectId === projectId && f.path === folderPath && f.machine === machine);
        if (existing) return existing;
        const folder = { id: id(), projectId, path: folderPath, machine, linkedAt: now() };
        db.folders.push(folder);
        event(db, { kind: 'agent', id: 'folder-connector', name: 'Local connector', handle: 'local-connector' }, projectId, 'folder.linked', `${machine}: ${folderPath}`);
        return folder;
      });
      return send(res, 201, value);
    }

    let actor = baseStore.resolveActor
      ? await baseStore.resolveActor(credentialHashes(req))
      : await store.read(db => requireActor(db, req));
    if (!actor) fail(401, 'Sign in or connect an agent');
    csrf(req, actor);

    // Credentials and reviewer grants can change while a request is waiting
    // for the next database transaction. Resolve them again inside each
    // operation so a revoked agent cannot write using an older actor snapshot.
    if(baseStore.sharedRuntime && actor.workspaceId){
      await baseStore.consumeBudget({workspaceId:actor.workspaceId,actor,isWrite:!['GET','HEAD'].includes(method)});
      res.chargeTraffic=bytes=>baseStore.consumeBudget({workspaceId:actor.workspaceId,actor,responseBytes:bytes,committed:!['GET','HEAD'].includes(method)});
    } else if(baseStore.sharedRuntime){
      // Owner requests use their actual target workspace, not a user-provided
      // accounting key. Resource permission checks still run in the operation.
      const workspaceId=baseStore.requestWorkspace?await baseStore.requestWorkspace({actor,path}):null;
      if(workspaceId){
        await baseStore.consumeBudget({workspaceId,actor,isWrite:!['GET','HEAD'].includes(method)});
        res.chargeTraffic=bytes=>baseStore.consumeBudget({workspaceId,actor,responseBytes:bytes,committed:!['GET','HEAD'].includes(method)});
      }
    }
    const authorized = fn => db => {
      actor = requireActor(db, req);
      csrf(req, actor);
      if ((method === 'POST' && (/^\/api\/workspaces\/[^/]+\/(announcements|meetings)$/.test(path) || /^\/api\/meetings\/[^/]+\/rounds$/.test(path))
        || method === 'PATCH' && (/^\/api\/meetings\/[^/]+$/.test(path) || /^\/api\/meetings\/[^/]+\/participants$/.test(path))
        || method === 'GET' && /^\/api\/workspaces\/[^/]+\/coordination-roster$/.test(path)) && !canManage(actor)) fail(403, 'Manager permission required');
      if (!['GET', 'HEAD'].includes(method) && actor.kind === 'agent' && db.workspaces.find(w => w.id === actor.workspaceId)?.paused
        && path !== '/api/mentions/read' && !/^\/api\/workspaces\/[^/]+\/announcements(?:\/[^/]+\/ack)?$/.test(path)) fail(423, 'Workspace paused by manager. Read announcements and wait for resume.');
      return fn(db);
    };
    const jobDetail = method === 'GET' && path.match(/^\/api\/jobs\/([^/]+)$/);
    const goalDetail = method === 'GET' && path.match(/^\/api\/goals\/([^/]+)$/);
    const rawBefore=url.searchParams.get('before');
    if(rawBefore!==null&&(!/^\d+$/.test(rawBefore)||!Number.isSafeInteger(Number(rawBefore))||Number(rawBefore)<1||Number(rawBefore)>2147483647))fail(400,'Invalid round cursor');
    const resourceWorkspace=/^\/api\/(jobs|goals|projects|meetings|workspaces)\/[^/]+/.test(path)&&baseStore.requestWorkspace?await baseStore.requestWorkspace({actor,path}):null;
    const paginationScope=path.endsWith('/page')?{roundBefore:rawBefore?Number(rawBefore):null,historyBefore:rawBefore?Number(rawBefore):null,historyPageMode:path.endsWith('/history/page'),...{pageCursor:decodeCursor(url.searchParams.get('cursor')),pageJobs:path.endsWith('/jobs/page'),pageProjectId:path.match(/^\/api\/projects\/([^/]+)/)?.[1]}}:{};
    const readScope = jobDetail ? { commentJobId: jobDetail[1] }
      : goalDetail ? { commentGoalId: goalDetail[1] }
      : method === 'GET' && /^\/api\/projects\/[^/]+\/review-queue$/.test(path) ? {}
      : { omitHeavy: true };
    store = {
      read: fn => baseStore.read(authorized(fn), { ...readScope, ...readScopeFor(path, method, actor, credentialHashes(req)), ...(resourceWorkspace?{workspaceId:resourceWorkspace}:{}), ...paginationScope }),
      write: async fn => {
        const value=await baseStore.write(async db => {
          const result=await authorized(fn)(db);
          if(Buffer.byteLength(JSON.stringify(result ?? null,(key,item)=>key==='_ordinal'?undefined:item))>4*1024*1024)fail(413,'Operation response is too large; no changes were committed.');
          return result;
        }, { actor, path, ...credentialHashes(req), input: req.boardInput || {} });
        if(actor.workspaceId)waitHub.signal(actor.workspaceId);
        return value;
      },
    };

    if (path === '/api/auth/me' && method === 'GET') return send(res, 200, await store.read(db => ({ actor, workspaces: db.workspaces.filter(w => actor.kind === 'user' ? w.ownerId === actor.id : w.id === actor.workspaceId) })));
    if (path === '/api/workspaces' && method === 'GET') return send(res, 200, await store.read(db => db.workspaces.filter(w => actor.kind === 'user' ? w.ownerId === actor.id : w.id === actor.workspaceId)));

    let match;

    if((match=path.match(/^\/api\/jobs\/([^/]+)\/history\/page$/))&&method==='GET')return send(res,200,await store.read(db=>{
      const found=job(db,actor,match[1]);const kind=url.searchParams.get('kind')||'submissions';
      if(!['runs','submissions','reviews'].includes(kind))fail(400,'Invalid history kind');
      const field={runs:'runs',submissions:'submissionHistory',reviews:'reviewHistory'}[kind];
      const all=(found[field]||[]).map((item,index)=>({item,ordinal:item._ordinal||index+1})).filter(entry=>!paginationScope.historyBefore||entry.ordinal<paginationScope.historyBefore).sort((a,b)=>a.ordinal-b.ordinal);
      const visible=all.slice(-20);return {items:visible.map(entry=>entry.item),before:all.length>20?visible[0].ordinal:null};
    }));
    if((match=path.match(/^\/api\/meetings\/([^/]+)\/rounds\/page$/))&&method==='GET')return send(res,200,await store.read(db=>{
      const found=meeting(db,actor,match[1]);
      const all=db.meetingRounds.filter(item=>item.meetingId===found.id&&(!paginationScope.roundBefore||item.ordinal<paginationScope.roundBefore)).sort((a,b)=>a.ordinal-b.ordinal);
      const visible=all.slice(-20);return {items:visible.map(item=>roundView(db,actor,item)),before:all.length>20?visible[0].ordinal:null};
    }));
    if((match=path.match(/^\/api\/projects\/([^/]+)\/jobs\/page$/))&&method==='GET')return send(res,200,await store.read(db=>{
      project(db,actor,match[1]);return page(db.jobs.filter(item=>item.projectId===match[1]),paginationScope.pageCursor,'updatedAt');
    }));
    if((match=path.match(/^\/api\/(jobs|goals)\/([^/]+)\/comments\/page$/))&&method==='GET')return send(res,200,await store.read(db=>{
      const target=match[1]==='jobs'?job(db,actor,match[2]):goal(db,actor,match[2]);
      const key=match[1]==='jobs'?'jobId':'goalId';const result=page(db.comments.filter(item=>item[key]===target.id),paginationScope.pageCursor);
      result.items.reverse();return result;
    }));
    if ((match = path.match(/^\/api\/workspaces\/([^/]+)\/agents\/([^/]+)\/manager$/)) && method === 'PATCH') {
      if (actor.kind !== 'user') fail(403, 'Only the workspace owner can grant manager access');
      const input = await body(req);
      if (typeof input.canManage !== 'boolean') fail(400, 'canManage must be true or false');
      const value = await store.write(db => {
        workspace(db, actor, match[1]);
        const agent = db.agents.find(item => item.id === match[2] && item.workspaceId === match[1] && !item.revokedAt);
        if (!agent) fail(404, 'Active agent not found');
        agent.canManage = input.canManage;
        const { tokenHash, ...safe } = agent;
        return safe;
      });
      return send(res, 200, value);
    }
    if ((match = path.match(/^\/api\/workspaces\/([^/]+)\/coordination-roster$/)) && method === 'GET') {
      if (!canManage(actor)) fail(403, 'Manager permission required');
      return send(res, 200, await store.read(db => {
        workspace(db, actor, match[1]);
        const projects = db.projects.filter(item => item.workspaceId === match[1]);
        return {
          agents: db.agents.filter(item => item.workspaceId === match[1] && !item.revokedAt).map(item => ({ id: item.id, name: item.name, rootProjectId: item.rootProjectId })),
          openJobs: db.jobs.filter(item => item.status === 'idea' && !item.assignee && projects.some(project => project.id === item.projectId))
            .map(item => ({ id: item.id, title: item.title, projectId: item.projectId, rootProjectId: projects.find(project => project.id === item.projectId)?.parentProjectId || item.projectId, assignedAgentId: item.assignedAgentId || null })),
        };
      }));
    }
    if ((match = path.match(/^\/api\/workspaces\/([^/]+)\/announcements$/))) {
      if (method === 'GET') return send(res, 200, await store.read(db => {
        const w = workspace(db, actor, match[1]);
        return { paused: w.paused === true, messages: db.announcements.filter(item => item.workspaceId === w.id).slice(-200) };
      }));
      if (method === 'POST') {
        if (!canManage(actor)) fail(403, 'Manager permission required');
        const input = await body(req);
        const message = text(input.body, 'Message', 4000);
        const kind = input.kind || 'message';
        if (!['message', 'pause', 'resume', 'assignment'].includes(kind)) fail(400, 'Invalid announcement kind');
        const value = await store.write(db => {
          const w = workspace(db, actor, match[1]);
          let target = null, assignedJob = null;
          if (kind === 'assignment') {
            target = db.agents.find(item => item.id === input.targetAgentId && item.workspaceId === w.id && !item.revokedAt);
            if (!target) fail(400, 'Choose an active agent');
            assignedJob = db.jobs.find(item => item.id === input.jobId && db.projects.some(p => p.id === item.projectId && p.workspaceId === w.id && (p.parentProjectId || p.id) === target.rootProjectId));
            if (!assignedJob || assignedJob.status !== 'idea' || assignedJob.assignee) fail(409, 'Choose an open job in that agent’s project');
            assignedJob.assignedAgentId = target.id;
            assignedJob.updatedAt = now();
            event(db, actor, assignedJob.projectId, 'job.assigned', assignedJob.title, assignedJob.goalId, assignedJob.id);
          }
          if (kind === 'pause') w.paused = true;
          if (kind === 'resume') w.paused = false;
          const all = input.notifyAll === true || /@allagents\b/i.test(message) || kind === 'pause' || kind === 'resume';
          const names = new Set([...message.matchAll(/@([a-zA-Z][a-zA-Z0-9_-]{1,31})/g)].map(part => part[1].toLowerCase()));
          const recipients = db.agents.filter(item => item.workspaceId === w.id && !item.revokedAt && (all || item.id === target?.id || names.has(item.name.toLowerCase())));
          const item = { id: id(), workspaceId: w.id, kind, body: message, targetAgentId: target?.id || null, jobId: assignedJob?.id || null,
            from: actorRef(actor), receipts: recipients.map(agent => ({ agentId: agent.id, readAt: null })), createdAt: now() };
          db.announcements.push(item);
          for (const agent of recipients) db.mentions.push({ id: id(), recipientType: 'agent', recipientId: agent.id, commentId: null,
            announcementId: item.id, projectId: assignedJob?.projectId || agent.rootProjectId, goalId: null, jobId: assignedJob?.id || null,
            from: actorRef(actor), readAt: null, createdAt: item.createdAt });
          return { paused: w.paused === true, message: item };
        });
        return send(res, 201, value);
      }
    }
    if ((match = path.match(/^\/api\/workspaces\/([^/]+)\/announcements\/([^/]+)\/ack$/)) && method === 'POST') {
      if (actor.kind !== 'agent') fail(403, 'Only an agent can acknowledge an announcement');
      const value = await store.write(db => {
        workspace(db, actor, match[1]);
        const item = db.announcements.find(message => message.id === match[2] && message.workspaceId === match[1]);
        if (!item) fail(404, 'Announcement not found');
        const receipt = item.receipts.find(entry => entry.agentId === actor.id);
        if (!receipt) fail(403, 'Announcement was not addressed to this agent');
        receipt.readAt ||= now();
        return { id: item.id, readAt: receipt.readAt };
      });
      return send(res, 200, value);
    }
    if (path === '/api/meeting-memory' && actor.kind === 'agent') {
      if (method === 'GET') return send(res, 200, await store.read(db => meetingMemoryView(db, actor)));
      if (method === 'PUT') {
        const input = await body(req);
        const value = optionalText(input.body, 'Meeting memory', 12000);
        return send(res, 200, await store.write(db => {
          let item = db.meetingMemories.find(entry => entry.workspaceId === actor.workspaceId && entry.agentId === actor.id);
          if (!item) { item = { id: id(), workspaceId: actor.workspaceId, agentId: actor.id, body: '', updatedAt: now() }; db.meetingMemories.push(item); }
          item.body = value; item.updatedAt = now();
          return { body: item.body, updatedAt: item.updatedAt };
        }));
      }
    }
    if ((match = path.match(/^\/api\/workspaces\/([^/]+)\/meetings$/))) {
      if (method === 'GET') return send(res, 200, await store.read(db => {
        workspace(db, actor, match[1]);
        return db.meetings.filter(item => item.workspaceId === match[1] && (actor.kind === 'user' || item.participantIds.includes(actor.id) || canManage(actor)))
          .map(item => ({ ...item, participants: item.participantIds.map(agentId => db.agents.find(agent => agent.id === agentId)).filter(Boolean).map(agent => ({ id: agent.id, name: agent.name })) }));
      }));
      if (method === 'POST') {
        if (!canManage(actor)) fail(403, 'Manager permission required');
        const input = await body(req);
        const title = text(input.title, 'Meeting title', 160);
        const prompt = text(input.prompt, 'Question', 8000);
        const participantIds = input.participantIds;
        if (!Array.isArray(participantIds) || participantIds.length < 2 || participantIds.length > 12 || new Set(participantIds).size !== participantIds.length || !participantIds.includes(input.mainAgentId)) fail(400, 'Choose a main agent and 1–11 distinct panel agents');
        const value = await store.write(db => {
          workspace(db, actor, match[1]);
          if (participantIds.some(agentId => !db.agents.some(agent => agent.id === agentId && agent.workspaceId === match[1] && !agent.revokedAt))) fail(400, 'All participants must be active workspace agents');
          const found = { id: id(), workspaceId: match[1], title, mainAgentId: input.mainAgentId, participantIds, autoMode: false, status: 'active', createdAt: now(), updatedAt: now() };
          db.meetings.push(found);
          beginRound(db, found, { prompt, mode: input.mode || 'blind' });
          return meetingView(db, actor, found);
        });
        return send(res, 201, value);
      }
    }
    if ((match = path.match(/^\/api\/meetings\/([^/]+)$/))) {
      if (method === 'GET') return send(res, 200, await store.read(db => meetingView(db, actor, meeting(db, actor, match[1]))));
      if (method === 'PATCH') {
        if (!canManage(actor)) fail(403, 'Manager permission required');
        const input = await body(req);
        return send(res, 200, await store.write(db => {
          const found = meeting(db, actor, match[1]);
          if (input.status !== undefined) {
            if (!['active', 'closed'].includes(input.status)) fail(400, 'Invalid meeting status');
            found.status = input.status;
          }
          if (input.autoMode !== undefined) {
            if (typeof input.autoMode !== 'boolean') fail(400, 'autoMode must be true or false');
            found.autoMode = input.autoMode;
          }
          found.updatedAt = now();
          const last = db.meetingRounds.filter(item => item.meetingId === found.id).at(-1);
          if (found.status === 'active' && last) maybeAutoAdvance(db, found, last);
          return meetingView(db, actor, found);
        }));
      }
    }
    if ((match = path.match(/^\/api\/meetings\/([^/]+)\/wait$/)) && method === 'GET') {
      const since = url.searchParams.get('since') || '';
      const timeout = Math.min(30, Math.max(1, Number(url.searchParams.get('timeout') || 20)));
      const deadline = Date.now() + timeout * 1000;
      const workspaceId=actor.workspaceId||await baseStore.requestWorkspace?.({actor,path});
      while (true) {
        const revision=baseStore.sharedRuntime?await (actor.kind==='user'?baseStore.ownerVersion(actor.id):baseStore.workspaceVersion(workspaceId)):null;
        // Waiting checks read one version row, not the full board or meeting transcript.
        const version = baseStore.meetingVersion
          ? await baseStore.meetingVersion({ actor, ...credentialHashes(req), meetingId: match[1] })
          : await store.read(db => meeting(db, actor, match[1]).updatedAt);
        if(version===since && Date.now()>=deadline && url.searchParams.get('compact')==='1')return send(res,200,{timedOut:true,unchanged:true,updatedAt:version,meeting:null});
        if (version !== since || Date.now() >= deadline) {
          const value = await store.read(db => meetingView(db, actor, meeting(db, actor, match[1])));
          return send(res, 200, { timedOut: value.updatedAt === since, updatedAt:value.updatedAt, meeting: value });
        }
        if(baseStore.sharedRuntime){
          const wake=await waitForWorkspace(req,res,workspaceId,actor,deadline-Date.now(),revision);
          if(wake.aborted)return;
        } else await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    if ((match = path.match(/^\/api\/meetings\/([^/]+)\/participants$/)) && method === 'PATCH') {
      if (!canManage(actor)) fail(403, 'Manager permission required');
      const input = await body(req);
      return send(res, 200, await store.write(db => {
        const found = meeting(db, actor, match[1]);
        if (found.status !== 'active') fail(409, 'Meeting is closed');
        const agent = db.agents.find(item => item.id === input.agentId && item.workspaceId === found.workspaceId && !item.revokedAt);
        if (!agent) fail(400, 'Choose an active workspace agent');
        if (input.action === 'set-main') {
          if (!found.participantIds.includes(agent.id)) fail(400, 'Main agent must already be in the meeting');
          found.mainAgentId = agent.id;
        } else if (input.action === 'add') {
          if (!found.participantIds.includes(agent.id)) {
            if (found.participantIds.length >= 12) fail(409, 'Meeting is full');
            found.participantIds.push(agent.id);
          }
        } else if (input.action === 'remove') {
          if (agent.id === found.mainAgentId) fail(409, 'Choose a different main agent before removing this one');
          found.participantIds = found.participantIds.filter(agentId => agentId !== agent.id);
          const current = db.meetingRounds.filter(item => item.meetingId === found.id && item.stage !== 'complete').at(-1);
          if (current) {
            current.participantIds = current.participantIds.filter(agentId => agentId !== agent.id);
            if (current.targetAgentId === agent.id) { current.stage = 'complete'; current.completedAt = now(); }
            else progressRound(db, found, current);
          }
        } else fail(400, 'Action must be add, remove, or set-main');
        found.updatedAt = now();
        return meetingView(db, actor, found);
      }));
    }
    if ((match = path.match(/^\/api\/meetings\/([^/]+)\/rounds$/)) && method === 'POST') {
      if (!canManage(actor)) fail(403, 'Manager permission required');
      const input = await body(req);
      const prompt = text(input.prompt, 'Round prompt', 8000);
      return send(res, 201, await store.write(db => {
        const found = meeting(db, actor, match[1]);
        if (found.status !== 'active') fail(409, 'Meeting is closed');
        const round = beginRound(db, found, { prompt, mode: input.mode || 'open', targetAgentId: input.targetAgentId || null });
        found.updatedAt = now();
        return roundView(db, actor, round);
      }));
    }
    if ((match = path.match(/^\/api\/meetings\/([^/]+)\/rounds\/([^/]+)\/responses$/)) && method === 'POST') {
      if (actor.kind !== 'agent') fail(403, 'An agent connection is required');
      const input = await body(req);
      const answer = text(input.body, 'Response', 12000);
      return send(res, 201, await store.write(db => {
        const found = meeting(db, actor, match[1]);
        if (found.status !== 'active') fail(409, 'Meeting is closed');
        const round = db.meetingRounds.find(item => item.id === match[2] && item.meetingId === found.id);
        if (!round) fail(404, 'Round not found');
        if (!round.participantIds.includes(actor.id)) fail(403, 'You are not in this round');
        const kind = input.kind || 'answer';
        if (kind === 'synthesis') {
          if (round.mode !== 'blind' || round.stage !== 'synthesis' || actor.id !== round.mainAgentId) fail(409, 'Main synthesis is not ready');
        } else if (kind === 'answer') {
          if (round.mode === 'targeted' && (round.stage !== 'target' || actor.id !== round.targetAgentId)) fail(409, 'This round is for one agent');
          if (round.mode === 'open' && !(round.stage === 'answers' && actor.id !== round.mainAgentId || round.stage === 'main' && actor.id === round.mainAgentId)) fail(409, 'Wait for your turn');
          if (round.mode === 'blind' && round.stage !== 'answers') fail(409, 'Blind submissions are closed');
        } else fail(400, 'Invalid response kind');
        if (db.meetingResponses.some(item => item.roundId === round.id && item.agentId === actor.id && item.kind === kind)) fail(409, 'Already responded');
        const response = { id: id(), roundId: round.id, agentId: actor.id, kind, body: answer, createdAt: now() };
        db.meetingResponses.push(response);
        if (kind === 'synthesis' || round.mode === 'open' && actor.id === round.mainAgentId) { round.stage = 'complete'; round.completedAt = now(); }
        else progressRound(db, found, round);
        found.updatedAt = now();
        return { response, round: roundView(db, actor, round) };
      }));
    }
    if ((match = path.match(/^\/api\/meetings\/([^/]+)\/rounds\/([^/]+)\/votes$/)) && method === 'POST') {
      if (actor.kind !== 'agent') fail(403, 'An agent connection is required');
      const input = await body(req);
      if (!['open', 'blind'].includes(input.mode)) fail(400, 'Vote for open or blind');
      return send(res, 200, await store.write(db => {
        const found = meeting(db, actor, match[1]);
        const round = db.meetingRounds.find(item => item.id === match[2] && item.meetingId === found.id);
        if (!round) fail(404, 'Round not found');
        if (!round.participantIds.includes(actor.id) || round.stage !== 'complete') fail(409, 'Vote after completing your round');
        let vote = db.meetingVotes.find(item => item.roundId === round.id && item.agentId === actor.id);
        if (!vote) { vote = { id: id(), roundId: round.id, agentId: actor.id, mode: input.mode, createdAt: now() }; db.meetingVotes.push(vote); }
        else vote.mode = input.mode;
        found.updatedAt = now();
        if (found.status === 'active') maybeAutoAdvance(db, found, round);
        return meetingView(db, actor, found);
      }));
    }
    if ((match = path.match(/^\/api\/workspaces\/([^/]+)\/agents$/))) {
      const workspaceId = match[1];
      if (method === 'GET') return send(res, 200, await store.read(db => { workspace(db, actor, workspaceId); return db.agents.filter(a => a.workspaceId === workspaceId && (actor.kind === 'user' || (!a.revokedAt && a.rootProjectId === actor.rootProjectId))).map(({ tokenHash, ...safe }) => safe); }));
      if (method === 'POST') {
        if (actor.kind !== 'user') fail(403, 'Only the workspace owner can connect agents');
        const input = await body(req);
        const name = text(input.name, 'Agent name', 32);
        const rootProjectId = text(input.rootProjectId, 'Top-level project', 100);
        if (!nameOk(name)) fail(400, 'Use 2–32 letters, numbers, hyphens or underscores; start with a letter');
        const secret = token();
        const agent = await store.write(db => {
          workspace(db, actor, workspaceId);
          const root = db.projects.find(p => p.id === rootProjectId && p.workspaceId === workspaceId && !p.parentProjectId);
          if (!root) fail(400, 'Choose a top-level project in this workspace');
          if (db.agents.some(a => a.workspaceId === workspaceId && !a.revokedAt && a.name.toLowerCase() === name.toLowerCase())) fail(409, 'Agent name already used');
          const agent = issueAgent(db, { workspaceId, rootProjectId, name, credential: secret });
          return { id: agent.id, workspaceId, rootProjectId, name, createdAt: agent.createdAt };
        });
        return send(res, 201, { agent, token: secret });
      }
    }
    if ((match = path.match(/^\/api\/workspaces\/([^/]+)\/agents\/([^/]+)\/reviewer$/)) && method === 'PATCH') {
      if (actor.kind !== 'user') fail(403, 'Only the workspace owner can assign reviewers');
      const input = await body(req);
      if (typeof input.canReview !== 'boolean') fail(400, 'canReview must be true or false');
      const value = await store.write(db => {
        workspace(db, actor, match[1]);
        const agent = db.agents.find(a => a.id === match[2] && a.workspaceId === match[1]);
        if (!agent) fail(404, 'Agent not found');
        if (agent.revokedAt) fail(409, 'Revoked agents cannot review');
        if (!db.projects.some(p => p.id === agent.rootProjectId && !p.parentProjectId && p.workspaceId === match[1])) fail(409, 'Agent needs an active top-level project');
        agent.canReview = input.canReview;
        event(db, actor, agent.rootProjectId, input.canReview ? 'agent.reviewer_granted' : 'agent.reviewer_revoked', agent.name);
        const { tokenHash, ...safe } = agent;
        return safe;
      });
      return send(res, 200, value);
    }
    if ((match = path.match(/^\/api\/workspaces\/([^/]+)\/agents\/([^/]+)$/)) && method === 'DELETE') {
      if (actor.kind !== 'user') fail(403, 'Only the workspace owner can revoke agents');
      await store.write(db => { workspace(db, actor, match[1]); const agent = db.agents.find(a => a.id === match[2] && a.workspaceId === match[1]); if (!agent) fail(404, 'Agent not found'); if (!agent.revokedAt) { agent.revokedAt = now(); if (agent.rootProjectId) event(db, actor, agent.rootProjectId, 'agent.revoked', agent.name); } });
      return send(res, 200, { ok: true });
    }
    if ((match = path.match(/^\/api\/projects\/([^/]+)\/agent-invites$/))) {
      if (actor.kind !== 'user') fail(403, 'Only the workspace owner can manage invites');
      if (method === 'GET') return send(res, 200, await store.read(db => {
        const root = project(db, actor, match[1]);
        if (root.parentProjectId) fail(400, 'Choose a top-level project');
        return db.agentInvites.filter(invite => invite.rootProjectId === root.id).map(({ secretHash, ...safe }) => safe);
      }));
      if (method === 'POST') {
        const input = await body(req);
        const expiresMinutes = input.expiresMinutes === undefined ? 15 : input.expiresMinutes;
        const maxUses = input.maxUses === undefined ? 1 : input.maxUses;
        if (!Number.isInteger(expiresMinutes) || expiresMinutes < 5 || expiresMinutes > 60 || !Number.isInteger(maxUses) || maxUses < 1 || maxUses > 5) fail(400, 'Choose 5–60 minutes and 1–5 uses');
        const secret = token();
        const invite = await store.write(db => {
          const root = project(db, actor, match[1]);
          if (root.parentProjectId) fail(400, 'Choose a top-level project');
          const active = db.agentInvites.filter(entry => entry.rootProjectId === root.id && !entry.revokedAt && entry.useCount < entry.maxUses && Date.parse(entry.expiresAt) > Date.now());
          if (active.length >= 20) fail(429, 'Too many active invites for this project');
          const invite = { id: id(), workspaceId: root.workspaceId, rootProjectId: root.id, secretHash: hash(secret), createdBy: actorRef(actor), createdAt: now(), expiresAt: new Date(Date.now() + expiresMinutes * 60_000).toISOString(), maxUses, useCount: 0, revokedAt: null, redemptions: [] };
          db.agentInvites.push(invite);
          event(db, actor, root.id, 'agent.invite_created', `Invite created: ${maxUses} use(s), ${expiresMinutes} minute(s)`);
          const { secretHash, ...safe } = invite;
          return safe;
        });
        return send(res, 201, { invite, secret });
      }
    }
    if ((match = path.match(/^\/api\/projects\/([^/]+)\/agent-invites\/([^/]+)$/)) && method === 'DELETE') {
      if (actor.kind !== 'user') fail(403, 'Only the workspace owner can manage invites');
      await store.write(db => {
        const root = project(db, actor, match[1]);
        if (root.parentProjectId) fail(400, 'Choose a top-level project');
        const invite = db.agentInvites.find(entry => entry.id === match[2] && entry.rootProjectId === root.id);
        if (!invite) fail(404, 'Invite not found');
        if (!invite.revokedAt) { invite.revokedAt = now(); event(db, actor, root.id, 'agent.invite_revoked', `Invite ${invite.id} revoked`); }
      });
      return send(res, 200, { ok: true });
    }
    if ((match = path.match(/^\/api\/workspaces\/([^/]+)\/projects$/))) {
      const workspaceId = match[1];
      if (method === 'GET') return send(res, 200, await store.read(db => { workspace(db, actor, workspaceId); return db.projects.filter(p => p.workspaceId === workspaceId && visibleProject(db, actor, p)).map(p => projectView(db, p)); }));
      if (method === 'POST') {
        const input = await body(req);
        const name = text(input.name, 'Project name', 120);
        const description = typeof input.description === 'string' ? input.description.slice(0, 10000).trim() : '';
        const parentProjectId = input.parentProjectId || null;
        const value = await store.write(db => {
          workspace(db, actor, workspaceId);
          if (actor.kind === 'agent' && parentProjectId !== actor.rootProjectId) fail(403, 'Agents can only add feature projects within their assigned project');
          if (parentProjectId) {
            const parent = db.projects.find(p => p.id === parentProjectId && p.workspaceId === workspaceId && !p.parentProjectId);
            if (!parent || !visibleProject(db, actor, parent)) fail(400, 'Choose a top-level project in this workspace');
          }
          const p = { id: id(), workspaceId, parentProjectId, name, description, brief: emptyBrief(), workLocations: [], createdBy: actorRef(actor), createdAt: now() };
          db.projects.push(p); event(db, actor, p.id, 'project.created', name); return p;
        });
        return send(res, 201, value);
      }
    }
    if ((match = path.match(/^\/api\/projects\/([^/]+)$/)) && method === 'GET') return send(res, 200, await store.read(db => projectView(db, project(db, actor, match[1]))));
    if ((match = path.match(/^\/api\/projects\/([^/]+)\/scope-proposals$/))) {
      if (method === 'GET') return send(res, 200, await store.read(db => {
        const p = project(db, actor, match[1]);
        if (p.parentProjectId) fail(400, 'Choose a top-level project');
        return db.scopeProposals.filter(proposal => proposal.projectId === p.id && (actor.kind === 'user' || proposal.submittedBy.id === actor.id))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      }));
      if (method === 'POST') {
        if (actor.kind !== 'agent') fail(403, 'Only an assigned agent can propose project scope');
        const draft = scopeInput(await body(req));
        const proposal = await store.write(db => {
          const p = project(db, actor, match[1]);
          if (p.parentProjectId || p.id !== actor.rootProjectId) fail(403, 'Propose scope only for your assigned top-level project');
          if (db.scopeProposals.filter(item => item.projectId === p.id && item.submittedBy.id === actor.id && item.status === 'pending').length >= 5) fail(429, 'Resolve an earlier scope proposal first');
          const proposal = { id: id(), projectId: p.id, ...draft, baseline: scopeFingerprint(p), status: 'pending', submittedBy: actorRef(actor), createdAt: now(), decidedBy: null, decidedAt: null, decisionNote: null, appliedBrief: null, appliedPlan: null };
          db.scopeProposals.push(proposal);
          event(db, actor, p.id, 'project.scope_proposed', 'Project scope proposed for owner review');
          return proposal;
        });
        return send(res, 201, proposal);
      }
    }
    if ((match = path.match(/^\/api\/projects\/([^/]+)\/scope-proposals\/([^/]+)$/)) && method === 'GET') return send(res, 200, await store.read(db => {
      const p = project(db, actor, match[1]);
      if (p.parentProjectId) fail(400, 'Choose a top-level project');
      const proposal = db.scopeProposals.find(item => item.id === match[2] && item.projectId === p.id && (actor.kind === 'user' || item.submittedBy.id === actor.id));
      if (!proposal) fail(404, 'Scope proposal not found');
      return proposal;
    }));
    if ((match = path.match(/^\/api\/projects\/([^/]+)\/scope-proposals\/([^/]+)\/decision$/)) && method === 'POST') {
      if (actor.kind !== 'user') fail(403, 'Only the workspace owner can decide project scope');
      const input = await body(req);
      if (!['approve', 'reject'].includes(input.decision)) fail(400, 'Choose approve or reject');
      const note = input.reason === undefined || input.reason === '' ? '' : text(input.reason, 'Decision note', 2000);
      if (input.decision === 'reject' && !note) fail(400, 'Give a reason for rejecting the draft');
      const edited = input.decision === 'approve' && (input.brief !== undefined || input.plan !== undefined);
      const replacement = edited ? scopeInput({ brief: input.brief, plan: input.plan }) : null;
      const result = await store.write(db => {
        const p = project(db, actor, match[1]);
        if (p.parentProjectId) fail(400, 'Choose a top-level project');
        const proposal = db.scopeProposals.find(item => item.id === match[2] && item.projectId === p.id);
        if (!proposal) fail(404, 'Scope proposal not found');
        if (proposal.status !== 'pending') fail(409, 'This proposal already has a decision');
        if (input.decision === 'approve' && proposal.baseline !== scopeFingerprint(p)) fail(409, 'The project scope changed after this draft. Review the current brief before applying it');
        proposal.status = input.decision === 'approve' ? 'approved' : 'rejected';
        proposal.decidedBy = actorRef(actor);
        proposal.decidedAt = now();
        proposal.decisionNote = note;
        if (input.decision === 'approve') {
          p.brief = replacement?.brief || proposal.brief;
          p.scopePlan = replacement?.plan ?? proposal.plan;
          proposal.appliedBrief = { ...p.brief };
          proposal.appliedPlan = p.scopePlan;
        }
        event(db, actor, p.id, input.decision === 'approve' ? 'project.scope_approved' : 'project.scope_rejected', input.decision === 'approve' ? 'Project scope applied' : note);
        return proposal;
      });
      return send(res, 200, result);
    }
    if ((match = path.match(/^\/api\/projects\/([^/]+)\/review-queue$/)) && method === 'GET') return send(res, 200, await store.read(db => {
      const p = project(db, actor, match[1]);
      if (actor.kind === 'agent' && !actor.canReview) fail(403, 'Reviewer permission required');
      const ids = new Set([p.id, ...db.projects.filter(child => child.parentProjectId === p.id).map(child => child.id)]);
      return db.jobs.filter(j => ids.has(j.projectId) && j.status === 'review').sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||b.id.localeCompare(a.id)).slice(0,50).map(j => ({ ...jobView(db, j), projectName: db.projects.find(candidate => candidate.id === j.projectId)?.name || '' }));
    }));
    if ((match = path.match(/^\/api\/projects\/([^/]+)\/brief$/)) && method === 'PATCH') {
      if (actor.kind !== 'user') fail(403, 'Only the workspace owner can edit the project brief');
      const input = await body(req);
      const brief = briefInput(input);
      if (input.plan !== undefined && (typeof input.plan !== 'string' || input.plan.trim().length > 8000)) fail(400, 'Plan must be text (max 8000 characters)');
      const value = await store.write(db => {
        const p = project(db, actor, match[1]);
        p.brief = brief;
        if (input.plan !== undefined) p.scopePlan = input.plan.trim();
        event(db, actor, p.id, 'project.brief_updated', 'Project brief updated');
        return projectView(db, p);
      });
      return send(res, 200, value);
    }
    if ((match = path.match(/^\/api\/projects\/([^/]+)\/review-instructions$/)) && method === 'PATCH') {
      if (actor.kind !== 'user') fail(403, 'Only the workspace owner can edit review instructions');
      const input = await body(req);
      if (typeof input.instructions !== 'string' || input.instructions.trim().length > 4000) fail(400, 'Review instructions must be text (max 4000 characters)');
      const value = await store.write(db => {
        const p = project(db, actor, match[1]);
        p.reviewInstructions = input.instructions.trim();
        event(db, actor, p.id, 'project.review_instructions_updated', 'Review instructions updated');
        return projectView(db, p);
      });
      return send(res, 200, value);
    }
    if ((match = path.match(/^\/api\/projects\/([^/]+)\/work-locations$/)) && method === 'POST') {
      if (actor.kind !== 'user') fail(403, 'Only the workspace owner can manage work locations');
      const input = workLocationInput(await body(req));
      const value = await store.write(db => {
        const p = project(db, actor, match[1]);
        p.workLocations ||= [];
        if (p.workLocations.length >= 20) fail(400, 'A project can have up to 20 work locations');
        const location = { id: id(), ...input, createdAt: now() };
        p.workLocations.push(location);
        event(db, actor, p.id, 'project.work_location_added', location.label);
        return location;
      });
      return send(res, 201, value);
    }
    if ((match = path.match(/^\/api\/projects\/([^/]+)\/work-locations\/([^/]+)$/)) && method === 'DELETE') {
      if (actor.kind !== 'user') fail(403, 'Only the workspace owner can manage work locations');
      await store.write(db => {
        const p = project(db, actor, match[1]);
        p.workLocations ||= [];
        const index = p.workLocations.findIndex(location => location.id === match[2]);
        if (index === -1) fail(404, 'Work location not found');
        const [location] = p.workLocations.splice(index, 1);
        event(db, actor, p.id, 'project.work_location_removed', location.label);
      });
      return send(res, 200, { ok: true });
    }
    if ((match = path.match(/^\/api\/projects\/([^/]+)\/needs-you$/)) && method === 'GET') {
      if (actor.kind !== 'user') fail(403, 'Only the workspace owner can view Needs you');
      return send(res, 200, await store.read(db => needsYouView(db, project(db, actor, match[1]))));
    }
    if ((match = path.match(/^\/api\/projects\/([^/]+)\/folder-pairings$/)) && method === 'POST') {
      if (actor.kind !== 'user') fail(403, 'Only the workspace owner can pair a local folder');
      const pairingCode = token();
      const value = await store.write(db => {
        project(db, actor, match[1]);
        const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
        db.folderPairings = db.folderPairings.filter(p => Date.parse(p.expiresAt) > Date.now() && !p.usedAt);
        db.folderPairings.push({ id: id(), projectId: match[1], codeHash: hash(pairingCode), expiresAt, usedAt: null });
        return { code: pairingCode, projectId: match[1], expiresAt };
      });
      return send(res, 201, value);
    }
    if ((match = path.match(/^\/api\/projects\/([^/]+)\/folders$/)) && method === 'GET') return send(res, 200, await store.read(db => { project(db, actor, match[1]); return db.folders.filter(f => f.projectId === match[1]); }));
    if ((match = path.match(/^\/api\/projects\/([^/]+)\/folders\/([^/]+)$/)) && method === 'DELETE') {
      if (actor.kind !== 'user') fail(403, 'Only the workspace owner can unlink a folder');
      await store.write(db => { project(db, actor, match[1]); const found = db.folders.find(f => f.id === match[2] && f.projectId === match[1]); if (!found) fail(404, 'Folder connection not found'); db.folders = db.folders.filter(f => f.id !== found.id); event(db, actor, match[1], 'folder.unlinked', `${found.machine}: ${found.path}`); });
      return send(res, 200, { ok: true });
    }
    if ((match = path.match(/^\/api\/projects\/([^/]+)\/goals$/))) {
      if (method === 'GET') return send(res, 200, await store.read(db => { project(db, actor, match[1]); return db.goals.filter(g => g.projectId === match[1]); }));
      if (method === 'POST') {
        const input = await body(req);
        const title = text(input.title, 'Goal title', 160);
        const value = await store.write(db => { project(db, actor, match[1]); const g = { id: id(), projectId: match[1], title, description: String(input.description || '').slice(0, 10000), createdBy: actorRef(actor), createdAt: now() }; db.goals.push(g); event(db, actor, g.projectId, 'goal.created', title, g.id); return g; });
        return send(res, 201, value);
      }
    }
    if ((match = path.match(/^\/api\/goals\/([^/]+)$/))) {
      if (method === 'GET') return send(res, 200, await store.read(db => { const g = goal(db, actor, match[1]); return { ...g, jobs: db.jobs.filter(j => j.goalId === g.id), comments: db.comments.filter(c => c.goalId === g.id).slice(-50), commentsPage: commentPage(db.comments.filter(c=>c.goalId===g.id)) }; }));
      if (method === 'PATCH') {
        const input = await body(req);
        const value = await store.write(db => { const g = goal(db, actor, match[1]); if (input.title !== undefined) g.title = text(input.title, 'Goal title', 160); if (input.description !== undefined) g.description = String(input.description).slice(0, 10000); event(db, actor, g.projectId, 'goal.updated', g.title, g.id); return g; });
        return send(res, 200, value);
      }
    }
    if ((match = path.match(/^\/api\/projects\/([^/]+)\/jobs$/))) {
      if (method === 'GET') return send(res, 200, await store.read(db => { project(db, actor, match[1]); return db.jobs.filter(j => j.projectId === match[1]); }));
      if (method === 'POST') {
        const input = await body(req);
        const title = text(input.title, 'Job title', 160);
        const bodyText = String(input.body || '').slice(0, 20000).trim();
        const value = await store.write(db => {
          project(db, actor, match[1]);
          if (input.goalId && goal(db, actor, input.goalId).projectId !== match[1]) fail(400, 'Goal belongs to another project');
          const j = { id: id(), projectId: match[1], goalId: input.goalId || null, title, body: bodyText, startingPoint: startingPointInput(input.startingPoint === undefined ? {} : input.startingPoint), status: 'idea', assignee: null, createdBy: actorRef(actor), createdAt: now(), updatedAt: now() };
          db.jobs.push(j); event(db, actor, j.projectId, 'job.created', title, j.goalId, j.id); return j;
        });
        return send(res, 201, value);
      }
    }
    if ((match = path.match(/^\/api\/jobs\/([^/]+)$/))) {
      if (method === 'GET') return send(res, 200, await store.read(db => jobView(db, job(db, actor, match[1]))));
      if (method === 'PATCH') {
        const input = await body(req);
        const value = await store.write(db => { const j = job(db, actor, match[1]); if (input.startingPoint !== undefined) { if (actor.kind !== 'user' && !sameActor(j.createdBy, actor)) fail(403, 'Only the owner or creator can edit starting directions'); if (j.status !== 'idea') fail(409, 'Starting directions can only change in Ideas'); j.startingPoint = startingPointInput(input.startingPoint); } if (input.title !== undefined) j.title = text(input.title, 'Job title', 160); if (input.body !== undefined) j.body = String(input.body).slice(0, 20000); j.updatedAt = now(); event(db, actor, j.projectId, 'job.updated', j.title, j.goalId, j.id); return j; });
        return send(res, 200, value);
      }
    }
    if ((match = path.match(/^\/api\/jobs\/([^/]+)\/claim$/)) && method === 'POST') {
      const input = await body(req);
      const value = await store.write(db => { const j = job(db, actor, match[1]); if (j.assignee) fail(409, `Already claimed by ${j.assignee.name}`); if (j.assignedAgentId && (actor.kind !== 'agent' || actor.id !== j.assignedAgentId)) fail(403, 'This job is assigned to another agent'); if (j.status !== 'idea' && j.status !== 'working') fail(409, 'This job cannot be claimed now'); j.run = { id: id(), directions: startingPointInput(j.startingPoint || {}), startingPoint: input.startingPoint === undefined ? null : startingPointInput(input.startingPoint), startedBy: actorRef(actor), startedAt: now() }; j.runs ||= []; j.runs.push(j.run); j.assignee = actorRef(actor); j.status = 'working'; j.updatedAt = now(); event(db, actor, j.projectId, 'job.claimed', j.title, j.goalId, j.id); return j; });
      return send(res, 200, value);
    }
    if ((match = path.match(/^\/api\/jobs\/([^/]+)\/requests$/)) && method === 'POST') {
      if (actor.kind !== 'agent') fail(403, 'Only an assigned agent can request a decision');
      const input = await body(req);
      const kind = input.kind;
      if (!['question', 'blocker'].includes(kind)) fail(400, 'Request kind must be question or blocker');
      const question = text(input.question, 'Question', 500);
      const context = text(input.context, 'Context', 4000);
      const recommendation = input.recommendation === undefined || input.recommendation === null || input.recommendation === '' ? '' : text(input.recommendation, 'Recommendation', 2000);
      const value = await store.write(db => {
        const j = job(db, actor, match[1]);
        if (j.status !== 'working' || !sameActor(j.assignee, actor)) fail(409, 'Claim and work on this job before requesting a decision');
        if (db.jobRequests.some(r => r.jobId === j.id && r.status === 'pending')) fail(409, 'Answer the pending request before opening another');
        const request = { id: id(), jobId: j.id, projectId: j.projectId, kind, question, context, recommendation, status: 'pending', askedBy: actorRef(actor), createdAt: now(), response: null, respondedBy: null, respondedAt: null };
        db.jobRequests.push(request);
        j.updatedAt = request.createdAt;
        event(db, actor, j.projectId, 'job.requested', question, j.goalId, j.id);
        return request;
      });
      return send(res, 201, value);
    }
    if ((match = path.match(/^\/api\/jobs\/([^/]+)\/requests\/([^/]+)\/respond$/)) && method === 'POST') {
      if (actor.kind !== 'user') fail(403, 'Only the workspace owner can answer a request');
      const input = await body(req);
      const response = text(input.response, 'Response', 4000);
      const value = await store.write(db => {
        const j = job(db, actor, match[1]);
        const request = db.jobRequests.find(r => r.id === match[2] && r.jobId === j.id);
        if (!request) fail(404, 'Request not found');
        if (request.status !== 'pending') fail(409, 'Request is no longer pending');
        request.status = 'answered'; request.response = response; request.respondedBy = actorRef(actor); request.respondedAt = now();
        j.updatedAt = request.respondedAt;
        event(db, actor, j.projectId, 'job.request_answered', response.slice(0, 160), j.goalId, j.id);
        return request;
      });
      return send(res, 200, value);
    }
    if ((match = path.match(/^\/api\/jobs\/([^/]+)\/move$/)) && method === 'POST') {
      const input = await body(req);
      if (!statuses.includes(input.status)) fail(400, 'Invalid status');
      const value = await store.write(db => {
        const j = job(db, actor, match[1]);
        if (input.reviewEvidence !== undefined && !(j.status === 'working' && input.status === 'review')) fail(400, 'Evidence can only be supplied with a new submission');
        if (!allowedMoves[j.status].includes(input.status)) fail(409, `Cannot move ${j.status} to ${input.status}`);
        if (input.status === 'working' && !j.assignee) fail(409, 'Claim the job first');
        if (input.status === 'review' && !sameActor(j.assignee, actor) && actor.kind !== 'user') fail(403, 'Only the assignee can submit for review');
        if (input.status === 'review' && db.jobRequests.some(r => r.jobId === j.id && r.status === 'pending')) fail(409, 'Answer the pending request before review');
        if (j.status === 'review' && actor.kind !== 'user' && !actor.canReview) fail(403, 'Only the workspace owner or an assigned reviewer can decide a review');
        if (input.status === 'completed' && (sameActor(j.assignee, actor) || sameActor(j.submission?.submittedBy, actor))) fail(403, 'A different reviewer must complete this job');
        if (j.status === 'review' && input.status === 'working' && actor.kind === 'agent' && (sameActor(j.assignee, actor) || sameActor(j.submission?.submittedBy, actor))) fail(403, 'A different reviewer must request changes');
        if (['review', 'completed'].includes(input.status) || (j.status === 'review' && input.status === 'working')) text(input.comment, 'Review note', 4000);
        if (input.status === 'review') {
          if (j.status === 'working') {
            j.submissionHistory ||= j.submission ? [j.submission] : [];
            j.submission = { id: id(), summary: input.comment.trim(), submittedBy: actorRef(actor), submittedAt: now(), run: j.run || null, reviewEvidence: reviewEvidenceInput(input.reviewEvidence) };
            j.submissionHistory.push(j.submission);
          }
          delete j.reviewDecision;
        }
        if (j.status === 'review' && ['working', 'completed'].includes(input.status)) {
          j.reviewDecision = { submissionId: j.submission?.id || null, outcome: input.status === 'completed' ? 'approved' : 'changes_requested', note: input.comment.trim(), decidedBy: actorRef(actor), decidedAt: now() };
          j.reviewHistory ||= [];
          j.reviewHistory.push(j.reviewDecision);
          event(db, actor, j.projectId, 'job.review_decided', j.reviewDecision.outcome, j.goalId, j.id);
        }
        if (input.status === 'idea') {
          for (const request of db.jobRequests.filter(r => r.jobId === j.id && r.status === 'pending')) {
            request.status = 'cancelled'; request.cancelledAt = now(); request.cancelledBy = actorRef(actor);
            request.cancellationReason = typeof input.comment === 'string' && input.comment.trim() ? input.comment.trim().slice(0, 4000) : 'Job returned to Ideas';
            event(db, actor, j.projectId, 'job.request_cancelled', request.question, j.goalId, j.id);
          }
          j.submissionHistory ||= j.submission ? [j.submission] : [];
          j.assignee = null; delete j.run; delete j.submission; delete j.reviewDecision;
        }
        j.status = input.status; j.updatedAt = now();
        event(db, actor, j.projectId, 'job.moved', `${j.title} → ${j.status}`, j.goalId, j.id);
        if (typeof input.comment === 'string' && input.comment.trim()) {
          const c = { id: id(), projectId: j.projectId, goalId: j.goalId, jobId: j.id, author: actorRef(actor), body: input.comment.trim().slice(0, 4000), createdAt: now() };
          db.comments.push(c); addMentions(db, actor, db.projects.find(p => p.id === j.projectId).workspaceId, c.body, c.id, c.projectId, c.goalId, c.jobId);
          event(db, actor, j.projectId, 'job.comment', c.body.slice(0, 160), j.goalId, j.id);
        }
        return j;
      });
      return send(res, 200, value);
    }
    if ((match = path.match(/^\/api\/(jobs|goals)\/([^/]+)\/comments$/)) && method === 'POST') {
      const input = await body(req);
      const bodyText = text(input.body, 'Comment', 4000);
      const value = await store.write(db => {
        const target = match[1] === 'jobs' ? job(db, actor, match[2]) : goal(db, actor, match[2]);
        const projectId = target.projectId;
        const goalId = match[1] === 'goals' ? target.id : target.goalId;
        const jobId = match[1] === 'jobs' ? target.id : null;
        const c = { id: id(), projectId, goalId, jobId, author: actorRef(actor), body: bodyText, createdAt: now() };
        db.comments.push(c);
        addMentions(db, actor, db.projects.find(p => p.id === projectId).workspaceId, bodyText, c.id, projectId, goalId, jobId);
        event(db, actor, projectId, jobId ? 'job.comment' : 'goal.comment', bodyText.slice(0, 160), goalId, jobId);
        return c;
      });
      return send(res, 201, value);
    }
    if ((match = path.match(/^\/api\/jobs\/([^/]+)\/votes$/)) && method === 'POST') {
      const input = await body(req);
      if (input.value !== 1 && input.value !== -1) fail(400, 'Vote must be +1 or -1');
      const reason = text(input.reason, 'Vote reason', 1000);
      const value = await store.write(db => { const j = job(db, actor, match[1]); let v = db.votes.find(v => v.jobId === j.id && v.voter.type === actor.kind && v.voter.id === actor.id); if (v) { v.value = input.value; v.reason = reason; v.updatedAt = now(); } else { v = { id: id(), jobId: j.id, voter: actorRef(actor), value: input.value, reason, updatedAt: now() }; db.votes.push(v); } event(db, actor, j.projectId, 'job.voted', `${input.value > 0 ? '+1' : '-1'} ${j.title}`, j.goalId, j.id); return v; });
      return send(res, 200, value);
    }
    if ((match = path.match(/^\/api\/projects\/([^/]+)\/activity$/)) && method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0);
      if (baseStore.listActivity) return send(res, 200, await baseStore.listActivity({ actor, ...credentialHashes(req), projectId: match[1], since }));
      return send(res, 200, await store.read(db => { const p = project(db, actor, match[1]); const branchIds = new Set([p.id, ...db.projects.filter(child => child.parentProjectId === p.id).map(child => child.id)]); return db.activity.filter(a => branchIds.has(a.projectId) && a.id > since).slice(0, 200); }));
    }
    if (path === '/api/mentions' && method === 'GET') {
      if (baseStore.listMentions) return send(res, 200, await baseStore.listMentions({ actor, ...credentialHashes(req) }));
      return send(res, 200, await store.read(db => { const mentions = db.mentions.filter(m => m.recipientType === actor.kind && m.recipientId === actor.id); return { unread: mentions.filter(m => !m.readAt).length, mentions: mentions.slice(-100).reverse() }; }));
    }
    if (path === '/api/mentions/read' && method === 'POST') {
      const input = await body(req);
      const ids = Array.isArray(input.ids) ? new Set(input.ids) : null;
      if (baseStore.markMentionsRead) await baseStore.markMentionsRead({ actor, ...credentialHashes(req), ids, readAt: now() });
      else await store.write(db => { for (const m of db.mentions) if (m.recipientType === actor.kind && m.recipientId === actor.id && (!ids || ids.has(m.id))) m.readAt = now(); });
      return send(res, 200, { ok: true });
    }
    if (path === '/api/mentions/wait' && method === 'GET') {
      const timeout = Math.min(120, Math.max(1, Number(url.searchParams.get('timeout') || 30)));
      const since = String(url.searchParams.get('since') || '');
      const deadline = Date.now() + timeout * 1000;
      const workspaceId=actor.workspaceId||await baseStore.requestWorkspace?.({actor,path});
      while (Date.now() < deadline) {
        const revision=baseStore.sharedRuntime?await (actor.kind==='user'?baseStore.ownerVersion(actor.id):baseStore.workspaceVersion(workspaceId)):null;
        const mentions = baseStore.listMentions
          ? (await baseStore.listMentions({ actor, ...credentialHashes(req), since, unreadOnly: true })).mentions
          : await store.read(db => db.mentions.filter(m => m.recipientType === actor.kind && m.recipientId === actor.id && !m.readAt && (!since || m.createdAt > since)));
        if (mentions.length) return send(res, 200, { timedOut: false, mentions });
        if(baseStore.sharedRuntime){
          const wake=await waitForWorkspace(req,res,workspaceId,actor,deadline-Date.now(),revision);
          if(wake.aborted)return;
        } else await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if(baseStore.resolveActor&&!await baseStore.resolveActor(credentialHashes(req)))fail(401,'Sign in or connect an agent');
      return send(res, 200, { timedOut: true, mentions: [] });
    }
    if ((match = path.match(/^\/api\/workspaces\/([^/]+)\/people$/)) && method === 'GET') return send(res, 200, await store.read(db => { const w = workspace(db, actor, match[1]); return [db.users.find(u => u.id === w.ownerId)].filter(Boolean).map(u => ({ type: 'user', ...publicUser(u) })).concat(db.agents.filter(a => a.workspaceId === w.id && !a.revokedAt && (actor.kind === 'user' || a.rootProjectId === actor.rootProjectId)).map(a => ({ type: 'agent', id: a.id, rootProjectId: a.rootProjectId, name: a.name, handle: a.name, canManage: a.canManage === true, createdAt: a.createdAt }))); }));
    fail(404, 'Endpoint not found');
  }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (!distDir || (req.method !== 'GET' && req.method !== 'HEAD')) return send(res, 404, { error: 'Not found' });
      const requested = normalize(join(distDir, url.pathname === '/' ? 'index.html' : url.pathname));
      const asset = requested.startsWith(`${normalize(distDir)}\\`) || requested.startsWith(`${normalize(distDir)}/`) ? requested : join(distDir, 'index.html');
      const file = await stat(asset).then(s => s.isFile() ? asset : join(distDir, 'index.html')).catch(() => join(distDir, 'index.html'));
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }[extname(file)] || 'application/octet-stream';
      res.writeHead(200, { 'content-type': mime }); res.end(await readFile(file));
    } catch (error) {
      if (!res.headersSent && !res.destroyed) await send(res, error.status || 500, { error: error.status ? error.message : 'Internal server error' }, error.retryAfter ? { 'retry-after': String(error.retryAfter) } : {});
      if (!error.status) console.error(error);
    }
  });
}
