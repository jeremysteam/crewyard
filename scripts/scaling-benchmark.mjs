import {performance} from 'node:perf_hooks';
import {writeFile} from 'node:fs/promises';
import {createWaitHub} from '../server/wait-hub.mjs';
import {rowBytes} from '../server/storage-metrics.mjs';
import {loadScoped,flattenState} from '../server/postgres-store.mjs';
import {readScopeFor} from '../server/read-scope.mjs';

// Fixture SQL model: selected table results are isolated to one workspace.
// This measures coordinator CPU and decoded JSON estimates, never live SQL.
const all={users:[],workspaces:[],agents:[],projects:[],jobs:[],meetings:[],meetingRounds:[],meetingResponses:[],nextActivityId:1};
for(let w=0;w<100;w++){
  all.workspaces.push({id:'w'+w,ownerId:'u'+w,name:'Workspace'});
  all.users.push({id:'u'+w,name:'Owner',handle:'owner'+w,email:'u'+w+'@example.test'});
  all.projects.push({id:'p'+w,workspaceId:'w'+w,name:'Project',workLocations:[]});
  all.agents.push({id:'a'+w,workspaceId:'w'+w,rootProjectId:'p'+w,name:'Agent'});
  for(let j=0;j<20;j++)all.jobs.push({id:'j'+w+'-'+j,projectId:'p'+w,title:'Job '+j,body:'x'.repeat(20000),status:'idea',createdAt:'2026-10-06T00:00:00.000Z',updatedAt:'2026-10-06T00:00:00.000Z'});
}
const broad=flattenState(all),beforeBytes=Object.values(broad).reduce((sum,rows)=>sum+rowBytes(rows),0);
const isolated=flattenState({...all,users:all.users.slice(0,1),workspaces:all.workspaces.slice(0,1),agents:all.agents.slice(0,1),projects:all.projects.slice(0,1),jobs:all.jobs.filter(j=>j.projectId==='p0').map(j=>({...j,body:j.body.slice(0,1000)}))});
let resultBytes=0,queries=0;
function sql(parts,...values){
  if(typeof parts==='string')return {text:'"'+parts+'"'};
  const text=parts.reduce((out,part,i)=>out+(i?(values[i-1]?.text||'?'):'')+part,'');
  return {text,then(resolve,reject){try{
    queries++;
    const table=text.match(/FROM board_private\."?([a-z_]+)"? WHERE/)?.[1];
    if(!table)throw Error('Unexpected fixture SQL');
    const rows=text.includes('GROUP BY')?[{project_id:'p0',status:'idea',total:20}]:isolated[table]||[];
    resultBytes+=rowBytes(rows);resolve(rows);
  }catch(error){reject(error);}}};
}
const actor={kind:'agent',id:'a0',workspaceId:'w0',rootProjectId:'p0'};
await loadScoped(sql,readScopeFor('/api/workspaces/w0/projects','GET',actor,{}));
const scenarios=[];
for(const agents of [25,100,1000]){
  const hub=createWaitHub({interval:5000}),started=performance.now();let probes=0,version=1;
  const waits=Array.from({length:agents},(_,i)=>hub.wait({key:'w0',actor:'agent'+i,since:1,probe:async()=>{probes++;return version;},timeout:1000}));
  await Promise.resolve();const idleProbes=probes;
  version=2;hub.signal('w0');await Promise.all(waits);
  scenarios.push({agents,baselinePeriodicProbesPerCycle:agents,sharedPeriodicProbesPerCycle:idleProbes,totalProbesIncludingWake:probes,localCoordinatorMs:Math.round((performance.now()-started)*100)/100});hub.close();
}
const report={kind:'offline-model',fixture:{workspaces:100,jobs:2000,bodyBytesPerJob:20000},snapshotComparison:{broadResultJsonBytes:beforeBytes,scopedResultJsonBytes:resultBytes,scopedQueries:queries},waitScenarios:scenarios,limits:'Not a PostgreSQL throughput benchmark or measured Supabase egress. Excludes protocol, auth, version and budget query bytes. Does not prove 1,000 productive agents or browser avatars. Broad snapshot is a comparison model, not a measurement of the last deployed patch.'};
console.log(JSON.stringify(report,null,2));
if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(report,null,2)+'\n');
