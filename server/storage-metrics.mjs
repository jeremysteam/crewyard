export function rowBytes(rows){return Buffer.byteLength(JSON.stringify(rows,(_,value)=>typeof value==='bigint'?String(value):value));}
export function createStorageMetrics({log=console.info,clock=Date.now,interval=60000}={}){
  const buckets=new Map();let last=clock();
  return {record(workspaceId,table,rows){
    const key=workspaceId||'account';const item=buckets.get(key)||{queries:0,rows:0,resultJsonBytes:0};
    item.queries++;item.rows+=rows.length;item.resultJsonBytes+=rowBytes(rows);buckets.set(key,item);
    if(clock()-last>=interval){
      for(const [workspace,totals]of buckets)log(JSON.stringify({event:'storage_usage',workspace,...totals,windowMs:clock()-last}));
      buckets.clear();last=clock();
    }
  },snapshot(){return Object.fromEntries([...buckets].map(([key,value])=>[key,{...value}]));}};
}
