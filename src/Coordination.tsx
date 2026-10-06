import { useVisiblePolling } from './useVisiblePolling';
import { useState, type FormEvent } from 'react';
import { api, patch, post } from './api';
import { Avatar } from './Avatar';
import type { Person, Project, Ref, Workspace } from './types';

type Receipt = { agentId: string; readAt: string | null };
type Announcement = { id: string; kind: 'message' | 'pause' | 'resume' | 'assignment'; body: string; from: Ref; targetAgentId: string | null; jobId: string | null; receipts: Receipt[]; createdAt: string };
type Agent = Person & { type: 'agent'; rootProjectId: string };
type MeetingResponse = { id: string; agentId: string; kind: 'answer' | 'synthesis'; body: string; createdAt: string };
type MeetingVote = { agentId: string; mode: 'open' | 'blind' };
type Round = { id: string; ordinal: number; prompt: string; mode: 'open' | 'blind' | 'targeted'; targetAgentId: string | null; participantIds: string[]; mainAgentId: string; stage: 'target' | 'answers' | 'main' | 'synthesis' | 'complete'; answerCount: number; responses: MeetingResponse[]; votes: MeetingVote[] };
type Meeting = { id: string; title: string; mainAgentId: string; participantIds: string[]; participants: { id: string; name: string }[]; autoMode: boolean; status: 'active' | 'closed'; rounds: Round[] };

const stamp = (value: string) => new Date(value).toLocaleString();

export function AnnouncementsPage({ workspace, people, projects, onChange }: { workspace: Workspace; people: Person[]; projects: Project[]; onChange: () => Promise<void> }) {
  const [data, setData] = useState<{ paused: boolean; messages: Announcement[] }>({ paused: false, messages: [] });
  const [kind, setKind] = useState<Announcement['kind']>('message');
  const [body, setBody] = useState('');
  const [notifyAll, setNotifyAll] = useState(false);
  const [agentId, setAgentId] = useState('');
  const [jobId, setJobId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const agents = people.filter((person): person is Agent => person.type === 'agent' && !!person.rootProjectId);
  const openJobs = projects.flatMap(project => project.jobs.filter(job => job.status === 'idea' && !job.assignee)
    .map(job => ({ job, project }))).filter(({ project }) => !agentId || agents.find(agent => agent.id === agentId)?.rootProjectId === (project.parentProjectId || project.id));
  async function refresh() { setData(await api(`/workspaces/${workspace.id}/announcements`)); }
  useVisiblePolling(async () => { try { await refresh(); } catch (cause) { setError((cause as Error).message); throw cause; } }, 5000, [workspace.id]);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      await post(`/workspaces/${workspace.id}/announcements`, { kind, body, notifyAll, targetAgentId: kind === 'assignment' ? agentId : undefined, jobId: kind === 'assignment' ? jobId : undefined });
      setBody(''); setJobId(''); await refresh(); await onChange();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="coordination-page">
    <div className="page-eyebrow">WORKSPACE COORDINATION</div><h1>Manager announcements</h1>
    <p>All connected agents can read this channel. Use @allagents or the notify option to ping every active agent. A pause blocks agent board writes; external agent sessions must check and honor the pause to stop their local work.</p>
    <div className={`coordination-status ${data.paused ? 'is-paused' : ''}`}>{data.paused ? 'Workspace paused — agents may read and acknowledge announcements, but cannot change board work.' : 'Workspace active'}</div>
    <form className="coordination-compose" onSubmit={event => void submit(event)}>
      <div className="coordination-row"><label>Action<select value={kind} onChange={event => setKind(event.target.value as Announcement['kind'])}><option value="message">Announcement</option><option value="pause">Stop all agents</option><option value="resume">Keep going</option><option value="assignment">Assign an open job</option></select></label>
      {kind === 'assignment' && <><label>Agent<select required value={agentId} onChange={event => { setAgentId(event.target.value); setJobId(''); }}><option value="">Choose agent</option>{agents.map(agent => <option key={agent.id} value={agent.id}>@{agent.name}</option>)}</select></label><label>Open job<select required value={jobId} onChange={event => setJobId(event.target.value)}><option value="">Choose job</option>{openJobs.map(({ job, project }) => <option key={job.id} value={job.id}>{project.name} · {job.title}</option>)}</select></label></>}
      </div>
      <label>Message<textarea required maxLength={4000} rows={3} value={body} onChange={event => setBody(event.target.value)} placeholder={kind === 'assignment' ? 'Tell the agent what to do with this job…' : 'Write the update agents should read…'} /></label>
      <div className="coordination-row"><label className="coordination-check"><input type="checkbox" checked={notifyAll} onChange={event => setNotifyAll(event.target.checked)} /> Notify @allagents</label><button className="button button-primary" disabled={busy || !body.trim()}>Post {kind === 'pause' ? 'stop' : kind === 'resume' ? 'resume' : kind === 'assignment' ? 'assignment' : 'announcement'}</button></div>
      {error && <div className="form-error">{error}</div>}
    </form>
    <div className="coordination-feed">{[...data.messages].reverse().map(message => <article className="coordination-card" key={message.id}>
      <div className="coordination-author"><Avatar id={message.from.id} name={message.from.name} bot={message.from.type === 'agent'} /><div><strong>{message.from.name}</strong> · <span>{message.kind}</span><small>{stamp(message.createdAt)}</small></div></div>
      <p>{message.body}</p>
      {message.jobId && <small>Job: {projects.flatMap(project => project.jobs).find(job => job.id === message.jobId)?.title || message.jobId}</small>}
      {!!message.receipts.length && <small>Read by {message.receipts.filter(receipt => receipt.readAt).length}/{message.receipts.length} agents</small>}
    </article>)}{!data.messages.length && <p>No announcements yet.</p>}</div>
  </div>;
}

export function MeetingsPage({ workspace, people }: { workspace: Workspace; people: Person[] }) {
  const agents = people.filter((person): person is Agent => person.type === 'agent' && !!person.rootProjectId);
  const [list, setList] = useState<Meeting[]>([]);
  const [selected, setSelected] = useState<Meeting | null>(null);
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [mainId, setMainId] = useState('');
  const [panelIds, setPanelIds] = useState<string[]>([]);
  const [mode, setMode] = useState<'open' | 'blind'>('blind');
  const [nextPrompt, setNextPrompt] = useState('');
  const [nextMode, setNextMode] = useState<'open' | 'blind' | 'targeted'>('open');
  const [targetId, setTargetId] = useState('');
  const [addId, setAddId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function refresh(meetingId?: string) {
    const meetings = await api<Meeting[]>(`/workspaces/${workspace.id}/meetings`);
    setList(meetings);
    const id = meetingId || selected?.id;
    if (id) setSelected(await api<Meeting>(`/meetings/${id}`));
  }
  useVisiblePolling(async () => { try { await refresh(); } catch (cause) { setError((cause as Error).message); throw cause; } }, 5000, [workspace.id, selected?.id]);
  async function act(work: () => Promise<Meeting>) { setError(''); setBusy(true); try { setSelected(await work()); await refresh(); } catch (cause) { setError((cause as Error).message); } finally { setBusy(false); } }
  async function create(event: FormEvent) {
    event.preventDefault();
    if (!mainId || !panelIds.length) { setError('Choose a main agent and at least one panel agent.'); return; }
    setError(''); setBusy(true);
    try {
      const meeting = await post<Meeting>(`/workspaces/${workspace.id}/meetings`, { title, prompt, mainAgentId: mainId, participantIds: [mainId, ...panelIds.filter(id => id !== mainId)], mode });
      setSelected(meeting); setTitle(''); setPrompt(''); await refresh(meeting.id);
    } catch (cause) { setError((cause as Error).message); } finally { setBusy(false); }
  }
  const current = selected?.rounds.at(-1);
  const names = Object.fromEntries([...agents, ...(selected?.participants || [])].map(agent => [agent.id, agent.name]));
  return <div className="coordination-page">
    <div className="page-eyebrow">MULTI AGENT DISCUSSION</div><h1>The Board</h1>
    <p>External agent sessions join with their own CrewYard credentials. Blind answers stay private until everyone submits; then the main agent speaks last with a synthesis. Auto mode opens the next round after all round participants vote.</p>
    <div className="coordination-layout"><aside className="coordination-list"><h2>Meetings</h2>{list.map(meeting => <button key={meeting.id} className={selected?.id === meeting.id ? 'active' : ''} onClick={() => void refresh(meeting.id)}><strong>{meeting.title}</strong><small>{meeting.status} · {meeting.participantIds.length} agents</small></button>)}{!list.length && <p>No meetings yet.</p>}</aside>
    <div className="coordination-main">{selected ? <>
      <div className="coordination-row"><div><h2>{selected.title}</h2><small className="author-with-avatar"><Avatar id={selected.mainAgentId} name={names[selected.mainAgentId] || selected.mainAgentId} bot size="small" />Main: {names[selected.mainAgentId] || selected.mainAgentId} · {selected.status}</small></div><button className="button button-subtle" onClick={() => setSelected(null)}>New meeting</button></div>
      <div className="coordination-row"><label className="coordination-check"><input type="checkbox" checked={selected.autoMode} disabled={busy || selected.status === 'closed'} onChange={event => void act(() => patch<Meeting>(`/meetings/${selected.id}`, { autoMode: event.target.checked }))} /> Auto mode</label><button className="button button-subtle" disabled={busy || selected.status === 'closed'} onClick={() => void act(() => patch<Meeting>(`/meetings/${selected.id}`, { status: 'closed', autoMode: false }))}>Close meeting</button></div>
<div className="coordination-card"><strong>Participants</strong><div className="coordination-row">{selected.participants.map(agent => <span key={agent.id} className="coordination-participant"><Avatar id={agent.id} name={agent.name} bot size="small" />@{agent.name} {agent.id !== selected.mainAgentId && selected.status === 'active' && <button disabled={busy} onClick={() => void act(() => patch<Meeting>(`/meetings/${selected.id}/participants`, { action: 'remove', agentId: agent.id }))}>×</button>}</span>)}</div>{selected.status === 'active' && <div className="coordination-row"><select value={addId} onChange={event => setAddId(event.target.value)}><option value="">Add agent</option>{agents.filter(agent => !selected.participantIds.includes(agent.id)).map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select><button className="button button-subtle" disabled={busy || !addId} onClick={() => void act(() => patch<Meeting>(`/meetings/${selected.id}/participants`, { action: 'add', agentId: addId }))}>Add</button></div>}</div>
      {selected.status === 'active' && <label className="coordination-main-select">Main agent for future rounds <select value={selected.mainAgentId} disabled={busy} onChange={event => void act(() => patch<Meeting>(`/meetings/${selected.id}/participants`, { action: 'set-main', agentId: event.target.value }))}>{selected.participants.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>}
      {selected.rounds.map(round => <article className="coordination-card" key={round.id}><div><strong>Round {round.ordinal} · {round.mode}</strong> · {round.stage}</div><p>{round.prompt}</p><small>{round.answerCount}/{round.participantIds.length} answers</small>{round.responses.map(response => <div className="coordination-answer" key={response.id}><div className="coordination-author"><Avatar id={response.agentId} name={names[response.agentId] || response.agentId} bot /><div><strong>{names[response.agentId] || response.agentId}{response.kind === 'synthesis' ? ' · synthesis' : ''}</strong><small>{stamp(response.createdAt)}</small></div></div><p>{response.body}</p></div>)}{round.mode === 'blind' && round.stage === 'answers' && <p>Answers are hidden until everyone submits.</p>}{round.stage === 'complete' && <small>Next round votes: {round.votes.length ? round.votes.map(vote => <span className="coordination-participant" key={vote.agentId}><Avatar id={vote.agentId} name={names[vote.agentId] || vote.agentId} bot size="small" />{names[vote.agentId] || vote.agentId}: {vote.mode}</span>) : 'none yet'}</small>}</article>)}
      {selected.status === 'active' && current?.stage === 'complete' && !selected.autoMode && <form className="coordination-compose" onSubmit={event => { event.preventDefault(); void act(() => post<Round>(`/meetings/${selected.id}/rounds`, { prompt: nextPrompt, mode: nextMode, targetAgentId: nextMode === 'targeted' ? targetId : undefined }).then(async () => { setNextPrompt(''); return api<Meeting>(`/meetings/${selected.id}`); })); }}><h3>Start next round</h3><textarea required value={nextPrompt} onChange={event => setNextPrompt(event.target.value)} maxLength={8000} rows={3} /><div className="coordination-row"><select value={nextMode} onChange={event => setNextMode(event.target.value as typeof nextMode)}><option value="open">Open</option><option value="blind">Blind</option><option value="targeted">One agent only</option></select>{nextMode === 'targeted' && <select required value={targetId} onChange={event => setTargetId(event.target.value)}><option value="">Choose agent</option>{selected.participants.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select>}<button className="button button-primary" disabled={busy}>Start round</button></div></form>}
    </> : <form className="coordination-compose" onSubmit={event => void create(event)}><h2>New meeting</h2><label>Title<input required maxLength={160} value={title} onChange={event => setTitle(event.target.value)} /></label><label>Question<textarea required maxLength={8000} rows={4} value={prompt} onChange={event => setPrompt(event.target.value)} /></label><label>Main agent<select required value={mainId} onChange={event => { setMainId(event.target.value); setPanelIds(ids => ids.filter(id => id !== event.target.value)); }}><option value="">Choose main agent</option>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label><strong>Panel</strong><div className="coordination-panel">{agents.filter(agent => agent.id !== mainId).map(agent => <label key={agent.id} className="coordination-check"><input type="checkbox" checked={panelIds.includes(agent.id)} onChange={event => setPanelIds(ids => event.target.checked ? [...ids, agent.id] : ids.filter(id => id !== agent.id))} /> <Avatar id={agent.id} name={agent.name} bot size="small" />{agent.name}</label>)}</div><label>First round<select value={mode} onChange={event => setMode(event.target.value as typeof mode)}><option value="blind">Blind</option><option value="open">Open</option></select></label><button className="button button-primary" disabled={busy || agents.length < 2}>Create meeting</button>{agents.length < 2 && <p>Connect at least two agents first.</p>}</form>}
    {error && <div className="form-error">{error}</div>}</div></div>
  </div>;
}
