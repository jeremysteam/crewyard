// One shared version probe per watched workspace per server, regardless of
// waiter count. Persistent revisions make commits on other servers visible.
export function createWaitHub({ interval=1000, maxWaiters=2000, maxPerActor=2 }={}) {
  const groups=new Map(), actors=new Map();let total=0;
  function remove(group,waiter,value,error){
    if(!group.waiters.delete(waiter))return;
    total--;actors.set(waiter.actor,(actors.get(waiter.actor)||1)-1);
    if(!actors.get(waiter.actor))actors.delete(waiter.actor);
    clearTimeout(waiter.deadline);waiter.signal?.removeEventListener('abort',waiter.abort);
    error?waiter.reject(error):waiter.resolve(value);
    if(!group.waiters.size){clearTimeout(group.timer);groups.delete(group.key);}
  }
  async function probe(group){
    if(!group.waiters.size||group.running)return;
    group.running=true;
    try{
      const version=String(await group.probe());
      for(const waiter of [...group.waiters])if(version!==waiter.since)remove(group,waiter,{version,timedOut:false});
    }catch(error){for(const waiter of [...group.waiters])remove(group,waiter,null,error);}
    finally{group.running=false;if(group.waiters.size)group.timer=setTimeout(()=>void probe(group),interval);}
  }
  return {
    wait({key,actor,since,probe:read,timeout,signal}){
      if(total>=maxWaiters||(actors.get(actor)||0)>=maxPerActor)throw Object.assign(new Error('Too many waiting requests. Retry later.'),{status:429,retryAfter:5});
      if(signal?.aborted)return Promise.resolve({timedOut:true,aborted:true});
      let group=groups.get(key);
      if(!group){group={key,probe:read,waiters:new Set(),running:false};groups.set(key,group);}
      return new Promise((resolve,reject)=>{
        const waiter={actor,since:String(since),signal,resolve,reject};
        waiter.abort=()=>remove(group,waiter,{timedOut:true,aborted:true});
        waiter.deadline=setTimeout(()=>remove(group,waiter,{timedOut:true,version:String(since)}),Math.max(1,timeout));
        group.waiters.add(waiter);total++;actors.set(actor,(actors.get(actor)||0)+1);
        signal?.addEventListener('abort',waiter.abort,{once:true});
        if(group.waiters.size===1)void probe(group);
      });
    },
    signal(key){const group=groups.get(key);if(group&&!group.running){clearTimeout(group.timer);void probe(group);}},
    close(){for(const group of [...groups.values()])for(const waiter of [...group.waiters])remove(group,waiter,{timedOut:true,aborted:true});},
    stats(){return {groups:groups.size,waiters:total};},
  };
}
