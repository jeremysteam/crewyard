import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createApp} from './app.mjs';
const when='2026-10-06T00:00:00.000Z',ref={type:'user',id:'u',name:'Owner',handle:'owner'};
async function harness(t){
  let db={users:[{id:'u',name:'Owner',handle:'owner'}],sessions:[],workspaces:[{id:'w',ownerId:'u'}],agents:[{id:'a',name:'Agent',workspaceId:'w',rootProjectId:'p',tokenHash:createHash('sha256').update('token').digest('hex')}],projects:[{id:'p',workspaceId:'w',name:'Project',workLocations:[]}],jobs:[],goals:[],jobRequests:[],comments:[],votes:[],mentions:[],activity:[],folders:[],meetings:[],meetingRounds:[],meetingResponses:[],meetingVotes:[],meetingMemories:[],nextActivityId:1};
  const store={read:async fn=>fn(structuredClone(db)),write:async fn=>{const next=structuredClone(db),result=await fn(next);db=next;return result;}};
  const server=createApp({store});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const origin='http://127.0.0.1:'+server.address().port;
  async function request(path,body){const res=await fetch(origin+'/api'+path,{method:body?'PATCH':'GET',headers:{authorization:'Bearer token',...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:res.status,data:await res.json()};}
  return {request,get db(){return db;}};
}
test('HTTP comment and job pages preserve ties and deny foreign project access',async t=>{
  const h=await harness(t);
  h.db.jobs=Array.from({length:231},(_,i)=>({id:'j'+String(i).padStart(3,'0'),projectId:'p',title:'Job',body:'Brief',status:'idea',createdAt:when,updatedAt:when}));
  h.db.comments=Array.from({length:127},(_,i)=>({id:'c'+String(i).padStart(3,'0'),projectId:'p',jobId:'j000',body:'Comment',author:ref,createdAt:when}));
  const detail=await h.request('/jobs/j000');assert.equal(detail.data.comments.length,50);
  const ids=detail.data.comments.map(c=>c.id);let cursor=detail.data.commentsPage.nextCursor;
  while(cursor){const res=await h.request('/jobs/j000/comments/page?cursor='+cursor);assert.equal(res.status,200);ids.push(...res.data.items.map(c=>c.id));cursor=res.data.nextCursor;}
  assert.equal(ids.length,127);assert.equal(new Set(ids).size,127);
  const jobs=[];cursor=null;
  do{const res=await h.request('/projects/p/jobs/page'+(cursor?'?cursor='+cursor:''));assert.equal(res.status,200);jobs.push(...res.data.items.map(j=>j.id));cursor=res.data.nextCursor;}while(cursor);
  assert.equal(new Set(jobs).size,231);
  assert.equal((await h.request('/projects/foreign/jobs/page')).status,404);
  assert.equal((await h.request('/jobs/j000/comments/page?cursor=bad')).status,400);
});
test('meeting history paging preserves round order and blind-answer privacy',async t=>{
  const h=await harness(t);h.db.meetings.push({id:'m',workspaceId:'w',title:'Board',participantIds:['a','b'],mainAgentId:'a'});
  h.db.meetingRounds=Array.from({length:63},(_,i)=>({id:'r'+i,meetingId:'m',ordinal:i+1,stage:'answers',mode:'blind',participantIds:['a','b']}));
  h.db.meetingResponses=h.db.meetingRounds.flatMap(r=>[{id:r.id+'a',roundId:r.id,agentId:'a',body:'Own answer',kind:'answer'},{id:r.id+'b',roundId:r.id,agentId:'b',body:'Hidden answer',kind:'answer'}]);
  const detail=await h.request('/meetings/m');assert.equal(detail.data.rounds.length,20);assert.equal(detail.data.rounds.at(-1).ordinal,63);
  const seen=[...detail.data.rounds];let before=detail.data.roundsPage.before;
  while(before){const res=await h.request('/meetings/m/rounds/page?before='+before);assert.equal(res.status,200);seen.push(...res.data.items);before=res.data.before;}
  assert.equal(new Set(seen.map(r=>r.id)).size,63);assert.ok(seen.every(r=>r.responses.length===1&&r.responses[0].agentId==='a'));
  assert.equal((await h.request('/meetings/m/rounds/page?before=2147483648')).status,400);
});
test('an oversized mutation response rolls back before any data is committed',async t=>{
  const h=await harness(t);h.db.jobs.push({id:'j',projectId:'p',title:'Original',status:'idea',createdAt:when,updatedAt:when,oversizedFixture:'x'.repeat(5*1024*1024)});
  const result=await h.request('/jobs/j',{title:'Changed'});assert.equal(result.status,413);
  assert.equal(h.db.jobs[0].title,'Original');assert.equal(h.db.activity.length,0);
});
