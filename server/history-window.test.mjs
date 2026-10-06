import test from 'node:test';
import assert from 'node:assert/strict';
import {flattenState,hydrateState,diffState} from './postgres-store.mjs';
const ref={type:'user',id:'u',name:'Owner',handle:'owner'};
function fixture(){const decision=i=>({submissionId:null,outcome:'changes_requested',note:'Decision '+i,decidedBy:ref,decidedAt:'2026-10-06T00:00:00.000Z'});return {projects:[],jobs:[{id:'j',projectId:'p',status:'review',reviewHistory:Array.from({length:10000},(_,i)=>decision(i+1)),reviewDecision:decision(1)}]};}
test('a 10,000-decision job appends ordinal 10,001 without rewriting or deleting hidden history',()=>{
  const rows=flattenState(fixture());
  rows.job_review_decisions=[rows.job_review_decisions[0],rows.job_review_decisions.at(-1)];
  const before=hydrateState(rows,1,{trackOrdinals:true}),after=structuredClone(before);
  assert.equal(before.jobs[0].reviewDecision.note,'Decision 1');
  const next={submissionId:null,outcome:'approved',note:'New review',decidedBy:ref,decidedAt:'2026-10-06T01:00:00.000Z'};
  after.jobs[0].reviewHistory.push(next);after.jobs[0].reviewDecision=next;
  const diff=diffState(before,after);
  assert.deepEqual(diff.delete,[]);assert.equal(diff.insert.length,1);
  assert.equal(diff.insert[0].row.id,'j:review:10001');assert.equal(diff.insert[0].row.ordinal,10001);
  assert.equal(diff.update.length,1);assert.equal(diff.update[0].row.current_review_decision_id,'j:review:10001');
  assert.ok(!('_ordinal' in diff.insert[0].row));
});
test('clearing a current decision preserves pinned older and newest historical rows',()=>{
  const rows=flattenState(fixture());rows.job_review_decisions=[rows.job_review_decisions[0],rows.job_review_decisions.at(-1)];
  const before=hydrateState(rows,1,{trackOrdinals:true}),after=structuredClone(before);
  delete after.jobs[0].reviewDecision;after.jobs[0].historyPage={reviews:9999};
  const diff=diffState(before,after);assert.deepEqual(diff.delete,[]);assert.deepEqual(diff.insert,[]);
  assert.equal(diff.update[0].row.current_review_decision_id,null);assert.ok(!('history_page' in diff.update[0].row));
});
