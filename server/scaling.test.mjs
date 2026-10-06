import test from 'node:test';
import assert from 'node:assert/strict';
import {createWaitHub} from './wait-hub.mjs';
import {createBudgetLimiter,defaultLimits} from './request-budget.mjs';
import {page,decodeCursor,encodeCursor} from './pagination.mjs';
import {writeScopeFor} from './operation-scope.mjs';
import {lockMutation,flattenState,diffState} from './postgres-store.mjs';

// Atomic counter model shared by independent limiter instances. No sockets.
export function budgetSql(){
  const counters=new Map();let queries=0;
  function sql(parts,...values){
    if(typeof parts==='string')return {field:parts};
    queries++;
    const [key,bucket,requests,writes,bytes]=values;
    const field=values[5].field,amount=values[7],limit=values[10],committed=values[11];
    const id=key+'|'+bucket;
    const row=counters.get(id);
    if(row){
      if(row[field]+amount>limit&&!committed)return Promise.resolve([]);
      row[field]+=amount;
    }else counters.set(id,{requests,writes,response_bytes:bytes});
    return Promise.resolve([{[field]:counters.get(id)[field]}]);
  }
  return {sql,counters,queries:()=>queries};
}
const actor={kind:'agent',id:'a',workspaceId:'w',rootProjectId:'p'};

test('1,000 idle waiters share a single workspace probe and all observe change',async()=>{
  const hub=createWaitHub({interval:5000});let probes=0,revision=1;
  const waits=Array.from({length:1000},(_,i)=>hub.wait({key:'w',actor:'a'+i,since:'1',probe:async()=>{probes++;return revision;},timeout:1000}));
  await Promise.resolve();assert.equal(probes,1);assert.deepEqual(hub.stats(),{groups:1,waiters:1000});
  revision=2;hub.signal('w');
  const results=await Promise.all(waits);
  assert.ok(results.every(item=>item.version==='2'&&!item.timedOut));
  assert.equal(probes,2);assert.deepEqual(hub.stats(),{groups:0,waiters:0});hub.close();
});
test('waiter isolation, disconnect cleanup, timeout, and actor capacity',async()=>{
  const hub=createWaitHub({interval:5000,maxWaiters:3,maxPerActor:1}),abort=new AbortController();
  const a=hub.wait({key:'w',actor:'a',since:1,probe:async()=>1,timeout:1000,signal:abort.signal});
  assert.throws(()=>hub.wait({key:'w',actor:'a',since:1,probe:async()=>1,timeout:1000}),{status:429});
  const b=hub.wait({key:'other',actor:'b',since:1,probe:async()=>1,timeout:15});
  abort.abort();assert.equal((await a).aborted,true);
  assert.equal(hub.stats().waiters,1);assert.equal((await b).timedOut,true);
  assert.deepEqual(hub.stats(),{groups:0,waiters:0});hub.close();
});
test('probe errors reject the group and clean all waiters',async()=>{
  const hub=createWaitHub();
  await assert.rejects(hub.wait({key:'w',actor:'a',since:1,probe:async()=>{throw Error('Unavailable');},timeout:100}),/Unavailable/);
  assert.deepEqual(hub.stats(),{groups:0,waiters:0});
});
test('two servers never grant the same request credits and rollover resets capacity',async()=>{
  const db=budgetSql();let time=0;
  const limits={...defaultLimits,actorRequests:7};
  const servers=[createBudgetLimiter(db.sql,{limits,clock:()=>time}),createBudgetLimiter(db.sql,{limits,clock:()=>time})];
  const results=await Promise.allSettled(Array.from({length:20},(_,i)=>servers[i%2].consume({workspaceId:'w',actor})));
  assert.equal(results.filter(item=>item.status==='fulfilled').length,7);
  assert.ok(results.filter(item=>item.status==='rejected').every(item=>item.reason.status===429&&item.reason.retryAfter===60));
  time=60000;await servers[0].consume({workspaceId:'w',actor});
  await servers[0].consume({workspaceId:'other',actor:{...actor,id:'other'}});
});
test('unused leases survive restart conservatively and writes have an independent cap',async()=>{
  const db=budgetSql(),limits={...defaultLimits,actorRequests:16,actorWrites:2};
  const first=createBudgetLimiter(db.sql,{limits,clock:()=>0});
  await first.consume({workspaceId:'w',actor,isWrite:true});
  const restarted=createBudgetLimiter(db.sql,{limits,clock:()=>0});
  await restarted.consume({workspaceId:'w',actor,isWrite:true});
  await assert.rejects(restarted.consume({workspaceId:'w',actor,isWrite:true}),{status:429});
  const row=[...db.counters].find(([id])=>id.startsWith('writes:actor:'))[1];assert.equal(row.writes,2);
});
test('byte cap refuses new work but does not hide a committed reply',async()=>{
  const db=budgetSql(),limits={...defaultLimits,workspaceResponseBytes:64,workspaceDailyResponseBytes:64,platformDailyResponseBytes:64};
  const limiter=createBudgetLimiter(db.sql,{limits,clock:()=>0});
  await limiter.consume({workspaceId:'w',actor});
  await limiter.consume({workspaceId:'w',actor,responseBytes:64,committed:true});
  await assert.rejects(limiter.consume({workspaceId:'w',actor}),{status:429});
});
test('concurrent requests coalesce capacity reservations and local maps stay bounded',async()=>{
  const db=budgetSql(),limiter=createBudgetLimiter(db.sql,{clock:()=>0});
  await Promise.all(Array.from({length:100},()=>limiter.consume({workspaceId:'w',actor})));
  assert.ok(db.queries()<45,'Leases avoid several counter writes for each request');
  const bounded=createBudgetLimiter(db.sql,{clock:()=>0,maxEntries:1});
  await assert.rejects(bounded.consume({workspaceId:'new',actor}),{status:503});
  assert.equal(bounded.snapshot().leases,1);
});
test('cursor pages retain timestamp ties without duplicates or lost items',()=>{
  const rows=Array.from({length:127},(_,i)=>({id:String(i).padStart(3,'0'),createdAt:'2026-10-06T00:00:00.000Z'}));
  const seen=[];let cursor=null;
  do{const result=page(rows,cursor);seen.push(...result.items.map(item=>item.id));cursor=decodeCursor(result.nextCursor);}while(cursor);
  assert.equal(seen.length,127);assert.equal(new Set(seen).size,127);
  for(const value of ['???',Buffer.from('["bad","id"]').toString('base64url'),encodeCursor({createdAt:'2026-10-06',id:'\0'})])assert.throws(()=>decodeCursor(value),{status:400});
});
test('operation plans bound entity graphs and preserve old append-only events',()=>{
  const scope=writeScopeFor('/api/jobs/j/claim',actor,{},{});
  assert.equal(scope.jobId,'j');assert.ok(!scope.selectedTables.includes('meetings'));assert.ok(scope.appendOnly.has('activity'));
  assert.throws(()=>writeScopeFor('/api/unplanned',actor,{}),{status:404});
  const state=Object.fromEntries(['users','sessions','agents','workspaces','projects','jobs','comments','activity'].map(name=>[name,[]]));
  const after=structuredClone(state);after.comments.push({id:'new',jobId:'j',body:'Update'});
  assert.deepEqual(diffState(state,after).delete,[]);assert.equal(flattenState(after).comments.length,1);
});
test('resource gates share independent jobs and exclude management mutations',async()=>{
  function recorder(){const queries=[];return {queries,sql:(parts,...params)=>{queries.push({text:parts.join('?'),params});return Promise.resolve([]);}};}
  const jobs=recorder();await lockMutation(jobs.sql,{...writeScopeFor('/api/jobs/j/claim',actor,{}),workspaceId:'w'});
  assert.ok(jobs.queries[0].text.endsWith('FOR SHARE'));assert.ok(jobs.queries.at(-1).text.includes('jobs'));assert.ok(jobs.queries.at(-1).text.endsWith('FOR UPDATE'));
  const pause=recorder();await lockMutation(pause.sql,{...writeScopeFor('/api/workspaces/w/announcements',actor,{},{}),workspaceId:'w'});
  assert.ok(pause.queries[0].text.endsWith('FOR UPDATE'));
});
