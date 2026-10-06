import { useEffect, useState } from 'react';
import { api } from './api';
import { Avatar } from './Avatar';
import type { Comment, Job } from './types';
type Page<T>={items:T[];nextCursor:string|null};

export function OlderComments({path,cursor}:{path:string;cursor?:string|null}){
  const [items,setItems]=useState<Comment[]>([]),[next,setNext]=useState(cursor),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{setItems([]);setNext(cursor);},[path,cursor]);
  async function load(){setBusy(true);setError('');try{const result=await api<Page<Comment>>(path+'?cursor='+encodeURIComponent(next||''));setItems(old=>[...result.items,...old]);setNext(result.nextCursor);}catch(cause){setError((cause as Error).message);}finally{setBusy(false);}}
  return <>{next&&<button className="button button-subtle" disabled={busy} onClick={()=>void load()}>{busy?'Loading…':'Load earlier comments'}</button>}{error&&<p role="alert">{error}</p>}{items.map(item=><div className="comment" key={item.id}><Avatar id={item.author.id} name={item.author.name} bot={item.author.type==='agent'} size="small"/><div><strong>{item.author.name}</strong><p>{item.body}</p></div></div>)}</>;
}
export function OlderJobs({projectId,onJob}:{projectId:string;onJob:(id:string)=>void}){
  const [items,setItems]=useState<Job[]>([]),[cursor,setCursor]=useState<string|null>(null),[started,setStarted]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{setItems([]);setCursor(null);setStarted(false);},[projectId]);
  async function load(){setBusy(true);setError('');try{const result=await api<Page<Job>>('/projects/'+projectId+'/jobs/page'+(cursor?'?cursor='+encodeURIComponent(cursor):''));setItems(old=>[...old,...result.items.filter(item=>!old.some(existing=>existing.id===item.id))]);setCursor(result.nextCursor);setStarted(true);}catch(cause){setError((cause as Error).message);}finally{setBusy(false);}}
  return <section className="drawer-section"><p>Showing recent jobs above. Browse this project’s full job list below.</p>{(!started||cursor)&&<button className="button button-subtle" disabled={busy} onClick={()=>void load()}>{busy?'Loading…':started?'Load more jobs':'Browse all jobs'}</button>}{error&&<p role="alert">{error}</p>}{items.map(item=><button className="job-card" key={item.id} onClick={()=>onJob(item.id)}><strong>{item.title}</strong><span className="status-pill">{item.status}</span></button>)}</section>;
}
