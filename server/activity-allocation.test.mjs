import test from 'node:test';
import assert from 'node:assert/strict';
import {persist} from './postgres-store.mjs';

test('independent entity diffs persist before reserving unique event IDs',async()=>{
  let counter=1;const order=[],ids=[];
  function sql(parts,...values){
    if(typeof parts==='string')return {identifier:parts};
    if(!Array.isArray(parts))return {row:parts};
    const text=parts.join('?');
    if(text.startsWith('UPDATE board_private.activity_counter')){const start=counter;counter+=values[0];order.push('counter');return Promise.resolve([{start}]);}
    if(text.startsWith('UPDATE board_private.')){order.push('entity:'+values[0].identifier);return Promise.resolve([]);}
    if(text.startsWith('INSERT INTO board_private.activity')){ids.push(values[0].row.id);order.push('event');return Promise.resolve([]);}
    throw Error('Unexpected SQL: '+text);
  }
  sql.json=value=>value;
  function pair(id){const before={jobs:[{id,projectId:'p',title:'Original'}],activity:[],nextActivityId:1};const after=structuredClone(before);after.jobs[0].title='Changed';after.activity.push({id:1,projectId:'p',action:'job.updated'});return [before,after];}
  await Promise.all([persist(sql,...pair('j1'),{allocateActivity:true}),persist(sql,...pair('j2'),{allocateActivity:true})]);
  assert.deepEqual(ids.sort(),[1,2]);assert.equal(counter,3);assert.ok(order.indexOf('counter')>order.indexOf('entity:jobs'));
});
