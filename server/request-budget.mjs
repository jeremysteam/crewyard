export const defaultLimits={workspaceRequests:2400,workspaceWrites:120,actorRequests:240,actorWrites:30,
  workspaceResponseBytes:16*1024*1024,workspaceDailyResponseBytes:1024*1024*1024,platformDailyResponseBytes:5*1024*1024*1024};

// PostgreSQL grants bounded capacity leases. Each server consumes its own
// credits locally; separate servers cannot obtain the same credits. Unused
// credits expire rather than being granted twice after a crash or restart.
export function createBudgetLimiter(sql,{limits=defaultLimits,clock=Date.now,maxEntries=20000}={}){
  const leases=new Map();
  async function reserve({key,bucket,field,amount,limit,committed}){
    if(amount>limit&&!committed)return false;
    const requests=field==='requests'?amount:0,writes=field==='writes'?amount:0,bytes=field==='response_bytes'?amount:0;
    const rows=await sql`INSERT INTO board_private.request_budgets (scope_key,bucket_start,requests,writes,response_bytes) VALUES (${key},${new Date(bucket).toISOString()},${requests},${writes},${bytes}) ON CONFLICT (scope_key,bucket_start) DO UPDATE SET ${sql(field)}=request_budgets.${sql(field)}+${amount} WHERE request_budgets.${sql(field)}+${amount}<=${limit} OR ${!!committed} RETURNING ${sql(field)}`;
    return rows.length===1;
  }
  async function consume(key,field,amount,limit,period,chunk,committed=false){
    const now=clock(),bucket=Math.floor(now/period)*period,cacheKey=key+':'+bucket;
    let lease=leases.get(cacheKey);
    if(!lease){
      if(leases.size>=maxEntries){for(const [id,item]of leases)if(item.expires<=now)leases.delete(id);}
      if(leases.size>=maxEntries)throw Object.assign(new Error('Traffic limiter capacity reached. Retry later.'),{status:503,retryAfter:5});
      lease={available:0,expires:bucket+period,queue:Promise.resolve()};leases.set(cacheKey,lease);
    }
    const work=lease.queue.then(async()=>{
      if(lease.available<amount){
        const needed=amount-lease.available;
        const wanted=committed?needed:Math.max(needed,Math.min(chunk,Math.max(1,Math.floor(limit/8))));
        const args={key,bucket,field,amount:wanted,limit,committed};
        if(await reserve(args))lease.available+=wanted;
        else if(wanted>needed&&await reserve({...args,amount:needed}))lease.available+=needed;
        else throw Object.assign(new Error('Traffic budget reached. Honor Retry-After before retrying.'),{status:429,retryAfter:Math.max(1,Math.ceil((bucket+period-now)/1000))});
      }
      lease.available-=amount;
    });
    lease.queue=work.catch(()=>{});await work;
  }
  async function bytes(workspaceId,amount,committed=false){
    await consume('bytes:workspace:'+workspaceId,'response_bytes',amount,limits.workspaceResponseBytes,60000,65536,committed);
    await consume('bytes:daily:workspace:'+workspaceId,'response_bytes',amount,limits.workspaceDailyResponseBytes,86400000,1048576,committed);
    await consume('bytes:daily:platform','response_bytes',amount,limits.platformDailyResponseBytes,86400000,1048576,committed);
  }
  return {async consume({workspaceId,actor,isWrite=false,responseBytes=0,committed=false}){
    if(!workspaceId||!actor?.id||!Number.isSafeInteger(responseBytes)||responseBytes<0)throw new Error('Invalid traffic accounting');
    if(responseBytes){await bytes(workspaceId,responseBytes,committed);return;}
    await consume('requests:actor:'+actor.kind+':'+actor.id,'requests',1,limits.actorRequests,60000,10);
    await consume('requests:workspace:'+workspaceId,'requests',1,limits.workspaceRequests,60000,32);
    if(isWrite){
      await consume('writes:actor:'+actor.kind+':'+actor.id,'writes',1,limits.actorWrites,60000,2);
      await consume('writes:workspace:'+workspaceId,'writes',1,limits.workspaceWrites,60000,4);
    }
    // Refuse new work once byte capacity is exhausted. This one-byte admission
    // allowance is conservative and covers empty/tiny responses as well.
    await bytes(workspaceId,1);
  },snapshot(){return {leases:leases.size};}};
}
