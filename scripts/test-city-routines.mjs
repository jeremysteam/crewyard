import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const folder=path.dirname(fileURLToPath(import.meta.url));
const repo=fs.existsSync(path.join(folder,'../src/cityRoutines.ts'))?path.resolve(folder,'..'):'E:/Work/Websites and software/agent-board-product';
const require=createRequire(path.join(repo,'package.json'));
const ts=require('typescript');
const cache=new Map();
function load(name){
  if(cache.has(name))return cache.get(name);
  const module={exports:{}};cache.set(name,module.exports);
  const js=ts.transpileModule(fs.readFileSync(path.join(repo,'src',name+'.ts'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  new Function('exports','require',js)(module.exports,specifier=>specifier.startsWith('./')?load(specifier.slice(2)):require(specifier));
  return module.exports;
}
const {cityRoutine}=load('cityRoutines');
const worker={id:'worker',type:'agent',name:'Worker',handle:'worker'};
const manager={...worker,id:'manager',canManage:true};
const owner={...worker,id:'owner',type:'user'};
const people=[worker,manager,owner];
const job=(id,status,agent=worker)=>({id,status,assignee:agent,title:id,createdAt:'2026-10-03T00:00:00Z',updatedAt:'2026-10-03T00:00:00Z'});
const jobs=[job('one','working'),job('two','working'),job('blocked','working'),job('foreign','working',{...worker,id:'other'}),job('done','completed')];
const original=JSON.stringify(jobs);
const blocked=new Set(['blocked']);
const sequence=Array.from({length:180},(_,second)=>cityRoutine(worker,jobs,people,blocked,second));
assert.deepEqual([...new Set(sequence.filter(step=>step.action==='build').map(step=>step.job.id))].sort(),['one','two'],'Build poses should rotate through actual unblocked assignments only');
assert.ok(sequence.some(step=>step.action==='carry')&&sequence.some(step=>step.action==='collect'),'Working agents should leave their sites to carry and collect parts');
assert.ok(new Set(sequence.map(step=>JSON.stringify(step.point))).size>=4,'A single standing pose must not be the whole work loop');
assert.equal(JSON.stringify(jobs),original,'Visual choreography must not mutate job state or assignments');
const blockedOnly=Array.from({length:70},(_,second)=>cityRoutine(worker,[jobs[2]],people,blocked,second));
assert.ok(blockedOnly.every(step=>step.action==='wait'),'Blocked-only agents must not keep building');
assert.equal(new Set(blockedOnly.map(step=>JSON.stringify(step.point))).size,1,'A blocked work loop should wait at its site');
for(const status of ['idea','review','completed']){
  const poses=Array.from({length:60},(_,second)=>cityRoutine(worker,[job('non-working',status)],people,new Set(),second));
  assert.ok(poses.every(step=>step.action!=='build'),'Planning, review, and finished jobs must not pose as ongoing construction');
  assert.ok(new Set(poses.map(step=>JSON.stringify(step.point))).size>1,'Assigned agents should walk between inspection or planning stops');
}
const rounds=Array.from({length:60},(_,second)=>cityRoutine(manager,jobs,people,blocked,second));
assert.ok(rounds.every(step=>step.action==='manage'),'Managers should supervise rather than appear to claim other agents’ jobs');
assert.ok(new Set(rounds.map(step=>JSON.stringify(step.point))).size>2,'Managers must make rounds');
const idle=Array.from({length:30},(_,second)=>cityRoutine(worker,[],people,new Set(),second));
assert.ok(idle.every(step=>!step.job&&step.action==='rest'),'Unassigned agents must not pretend to work on someone else’s job');
assert.ok(new Set(idle.map(step=>JSON.stringify(step.point))).size>1,'Unassigned bots should stroll');
assert.deepEqual(cityRoutine(owner,jobs,people,blocked,0),cityRoutine(owner,jobs,people,blocked,90),'The workspace owner should not enter bot work routines');
assert.ok([...sequence,...rounds,...idle].every(step=>step.point.x>=12&&step.point.x<=90&&step.point.y>=30&&step.point.y<=95),'Routines should remain on the map');
assert.deepEqual(cityRoutine(worker,jobs,people,blocked,42),cityRoutine(worker,jobs,people,blocked,42),'A paused routine clock should preserve its exact pose');
console.log('City routine checks passed: motion, actual assignment rotation, blockers, honest job states, manager rounds, idle strolls, unchanged data, and map bounds.');

const ground=load('crewCityModel');
assert.equal(ground.isCityWalkable({x:84,y:94}),false,'The reported waterfront location must be excluded from walking ground');
assert.equal(ground.isCityWalkable({x:55,y:95}),false,'The front cliff is not pavement even though it is inside the image');
assert.ok(ground.isCityWalkable(ground.cityWalkablePoint({x:84,y:94})),'An old waterfront stop must be relocated onto pavement');
const crowded=Array.from({length:28},(_,i)=>({...worker,id:'crew-'+i}));
for(const status of ['idea','working','review','completed']){
  const crowdedJobs=crowded.map((person,i)=>job('crowded-'+i,status,person));
  for(const person of crowded){
    let previous;
    for(let second=0;second<90;second++){
      const point=cityRoutine(person,crowdedJobs,crowded,new Set(),second).point;
      assert.ok(ground.isCityWalkable(point),'Crowded '+status+' stops must stay on pavement');
      if(previous)for(let frame=0;frame<=10;frame++){
        const progress=frame/10;
        assert.ok(ground.isCityWalkable({x:previous.x+(point.x-previous.x)*progress,y:previous.y+(point.y-previous.y)*progress}),'Movement between stops must never cross off the pavement');
      }
      previous=point;
    }
  }
}
assert.ok(idle.every(step=>ground.isCityWalkable(step.point))&&rounds.every(step=>ground.isCityWalkable(step.point)),'Idle strolls and manager visits must use the same pavement');
assert.ok(ground.isCityWalkable(ground.cityWalkablePoint({x:72+4,y:44+3})),'Conversation visit offsets must also stay on pavement');
console.log('Pavement regression checks passed: waterfront excluded, crowded stops inland, and whole travel segments remain on ground.');
