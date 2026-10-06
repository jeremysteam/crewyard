import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from './app.mjs';
import { readScopeFor } from './read-scope.mjs';
import { loadScoped, flattenState } from './postgres-store.mjs';

const actor={kind:'agent',id:'agent',workspaceId:'space',rootProjectId:'root'};
const owner={kind:'user',id:'owner'};
const hash=s=>createHash('sha256').update(s).digest('hex');
function state(){return {
  users:[{id:'owner',name:'Owner',handle:'owner',email:'owner@example.test'}],
  sessions:[{tokenHash:hash('owner-session'),userId:'owner',expiresAt:'2099-01-01T00:00:00.000Z'}],
  workspaces:[{id:'space',ownerId:'owner',name:'Space',paused:false}],
  agents:[{id:'agent',name:'Agent',workspaceId:'space',rootProjectId:'root',tokenHash:hash('agent-token'),canManage:true}],
  projects:[{id:'root',workspaceId:'space',parentProjectId:null,name:'Root',workLocations:[]}],
  jobs:[{id:'job',projectId:'root',goalId:'goal',status:'review',title:'Job',updatedAt:'2026-10-06T00:00:00Z',createdAt:'2026-10-06T00:00:00Z'}],
  goals:[{id:'goal',projectId:'root',title:'Goal'}],
  jobRequests:[],scopeProposals:[],comments:[{id:'comment',jobId:'job',projectId:'root',body:'Evidence'}],votes:[],
  agentInvites:[],authIdentities:[],mentions:[],activity:[],folderPairings:[],folders:[],
  announcements:[{id:'notice',workspaceId:'space',body:'Update'}],
  meetings:[{id:'meeting',workspaceId:'space',title:'Board',participantIds:['agent'],updatedAt:'2026-10-06T00:00:00.000Z'}],
  meetingRounds:[{id:'round',meetingId:'meeting',ordinal:1,prompt:'Question',mode:'blind',stage:'answers'}],
  meetingResponses:[{id:'answer',roundId:'round',agentId:'agent',kind:'answer',body:'Answer'}],meetingVotes:[],meetingMemories:[],nextActivityId:1};}

// This double never opens a socket. Awaited SELECTs return fixture rows and
// capture their parameterized SQL, including nested authorization filters.
function fakeSql(rows){
  const queries=[];
  const fragment=(text,params=[])=>({text,params,then(resolve,reject){try{
    queries.push({text,params});
    const table=text.match(/FROM board_private\."?([a-z_]+)"?(?: [a-z]+ JOIN[\s\S]*?)? WHERE/)?.[1];
    if(text.startsWith('SELECT h.*')){const child=text.match(/board_private\."(job_runs|job_submissions|job_review_decisions)" WHERE/)?.[1];resolve(rows[child]||[]);return;}
    if(text.startsWith('SELECT c.*')){resolve(rows.comments||[]);return;}
    if(!table)throw new Error('Unexpected query: '+text);
    if(text.includes('AS meeting_title')){resolve([]);}
    else if(text.includes('GROUP BY project_id,status')){
      const totals=new Map();for(const row of rows.jobs||[]){const key=row.project_id+':'+row.status;totals.set(key,(totals.get(key)||0)+1);}
      resolve([...totals].map(([key,total])=>{const split=key.lastIndexOf(':');return {project_id:key.slice(0,split),status:key.slice(split+1),total};}));
    }else resolve(rows[table]||[]);
  }catch(e){reject(e);}}});
  function sql(parts,...values){
    if(typeof parts==='string')return fragment('"'+parts+'"');
    let text=parts[0],params=[];
    values.forEach((value,i)=>{if(value&&typeof value.text==='string'){text+=value.text;params.push(...value.params);}
      else{text+='?';params.push(value);}text+=parts[i+1];});
    return fragment(text,params);
  }
  return {sql,queries};
}

test('announcement polling reads no job, transcript, activity, or credential history',async()=>{
  const {sql,queries}=fakeSql(flattenState(state()));
  const options=readScopeFor('/api/workspaces/space/announcements','GET',actor,{agentTokenHash:'token'});
  const result=await loadScoped(sql,options);
  assert.equal(result.announcements[0].body,'Update');
  assert.equal(result.jobs.length,0);
  assert.deepEqual(queries.map(q=>q.text.match(/FROM board_private\."?([a-z_]+)"? WHERE/)[1]).sort(),['agents','announcements','workspaces']);
  assert.ok(queries.every(q=>q.text.includes(' WHERE ')));
  assert.ok(queries.find(q=>q.text.includes('board_private.announcements')).text.includes('workspace_id IN'));
  assert.ok(queries.find(q=>q.text.includes('"agents"')).text.includes('WHERE id='));
  assert.ok(queries.every(q=>!q.text.includes('board_private.users')));
});

test('all planned read filters use valid relationships and parameterize input',async()=>{
  const paths=['/api/auth/me','/api/workspaces','/api/workspaces/space/people','/api/workspaces/space/projects',
    '/api/workspaces/space/coordination-roster','/api/workspaces/space/meetings','/api/meetings/meeting',
    '/api/meeting-memory','/api/projects/root','/api/projects/root/needs-you','/api/projects/root/scope-proposals',
    '/api/projects/root/agent-invites','/api/projects/root/goals','/api/projects/root/folders','/api/projects/root/jobs',
    '/api/projects/root/review-queue','/api/jobs/job','/api/goals/goal'];
  for(const person of [actor,owner])for(const path of paths){
    const {sql,queries}=fakeSql(flattenState(state()));
    const options=readScopeFor(path,'GET',person,{agentTokenHash:'token',sessionTokenHash:'session'});
    await loadScoped(sql,options);
    for(const q of queries){
      assert.ok(q.text.includes('WHERE'),path);
      if(q.text.match(/FROM board_private\."votes"/))assert.ok(q.text.includes('WHERE job_id IN'),path);
      if(person.kind==='agent'&&q.text.includes('board_private.projects'))assert.ok(q.text.includes('coalesce(parent_project_id, id)'),path);
    }
  }
  const {sql,queries}=fakeSql(flattenState(state()));
  const malicious="job' OR 1=1 --";
  await loadScoped(sql,readScopeFor('/api/jobs/'+malicious,'GET',actor,{agentTokenHash:'token'}));
  assert.ok(queries.some(q=>q.params.includes(malicious)));
  assert.ok(queries.every(q=>!q.text.includes(malicious)));
  assert.equal(readScopeFor('/api/unknown','GET',actor,{}),null);
  assert.equal(readScopeFor('/api/jobs/job','PATCH',actor,{}),null);
});

test('scoped HTTP reads retain data, blind privacy, and immediate revocation',async t=>{
  const db=state();
  db.meetingResponses.push({id:'other-answer',roundId:'round',agentId:'other-agent',kind:'answer',body:'Private panel answer'});
  // Only planned tables reach callbacks, just as with the PostgreSQL loader.
  const store={read:async(fn,options={})=>{
    const copy=structuredClone(db);
    if(options.selectedTables){
      const wanted=new Set(options.selectedTables);
      for(const name of Object.keys(copy)){
        const table=name.replace(/[A-Z]/g,c=>'_'+c.toLowerCase());
        if(Array.isArray(copy[name])&&!wanted.has(table))copy[name]=[];
      }
    }
    return fn(copy);
  },write:async()=>{throw new Error('This fixture is read only');}};
  const server=createApp({store});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port;
  async function get(path,asOwner=false){const res=await fetch(base+'/api'+path,{headers:asOwner?{cookie:'sid=owner-session'}:{authorization:'Bearer agent-token'}});return {status:res.status,data:await res.json()};}
  for(const path of ['/auth/me','/workspaces','/workspaces/space/announcements','/workspaces/space/people',
    '/workspaces/space/projects','/workspaces/space/meetings','/meetings/meeting','/meeting-memory',
    '/projects/root','/projects/root/jobs','/projects/root/goals','/projects/root/scope-proposals',
    '/jobs/job','/goals/goal'])assert.equal((await get(path)).status,200,path);
  assert.equal((await get('/jobs/job')).data.comments[0].body,'Evidence');
  assert.deepEqual((await get('/meetings/meeting')).data.rounds[0].responses.map(item=>item.id),['answer']);
  assert.equal((await get('/meetings/meeting',true)).data.rounds[0].responses.length,0);
  db.meetingRounds[0].stage='synthesis';
  assert.equal((await get('/meetings/meeting')).data.rounds[0].responses.length,2);
  assert.equal((await get('/projects/root/needs-you',true)).data.reviews.length,1);
  assert.equal((await get('/projects/root/review-queue',true)).data[0].comments[0].body,'Evidence');
  assert.equal((await get('/projects/foreign')).status,404);
  db.agents[0].revokedAt='2026-10-06T01:00:00.000Z';
  assert.equal((await get('/workspaces/space/announcements')).status,401);
});

test('unchanged meeting wait uses version probes and loads the transcript once at timeout',async t=>{
  const db=state();let reads=0,probes=0;
  const store={read:async fn=>{reads++;return fn(structuredClone(db));},
    meetingVersion:async()=>{probes++;return db.meetings[0].updatedAt;}};
  const server=createApp({store});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url='http://127.0.0.1:'+server.address().port+'/api/meetings/meeting/wait?timeout=2&since='+db.meetings[0].updatedAt;
  const response=await fetch(url,{headers:{authorization:'Bearer agent-token'}});
  assert.equal(response.status,200);
  assert.equal((await response.json()).timedOut,true);
  assert.ok(probes>=3);
  assert.equal(reads,2,'One authentication read and one transcript read, not a transcript per probe');
  const previous=reads;
  const compact=await fetch(url.replace('timeout=2','timeout=1')+'&compact=1',{headers:{authorization:'Bearer agent-token'}});
  const reply=await compact.json();assert.equal(reply.meeting,null);assert.equal(reply.unchanged,true);assert.equal(reply.updatedAt,db.meetings[0].updatedAt);
  assert.equal(reads-previous,1,'Compact unchanged timeout reads authentication but no transcript');
});
