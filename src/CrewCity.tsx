import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ArrowRight, Check, ChevronLeft, ClipboardCheck, Coffee, Crown, Flag, Focus, Footprints, Hammer, Leaf, MessageCircle, Pause, Play, RotateCcw, Search, Sparkles, Users, X, ZoomIn, ZoomOut, CircleHelp } from 'lucide-react';
import { api } from './api';
import { Avatar } from './Avatar';
import { CityJobSite } from './CityJobSite';
import { agentAppearance } from './agentAppearance';
import { agentJob, cityDistricts, cityHash, cityJobs, districtSiteJobs, conversationTarget, eventLabel, isCityEvent, isConversation, jobPoint, mergeCityActivity, personPoint, type CityPoint } from './crewCityModel';
import type { Activity, Job, JobStatus, NeedsYou, Person, Project } from './types';
import './crew-city.css';

type Selection = { kind: 'person' | 'job' | 'district'; id: string } | null;
type Bubble = { event: Activity; until: number; replay: boolean };
type CityProps = { project: Project | null; projects: Project[]; people: Person[]; inbox: NeedsYou | null; onProject: (id: string) => void; onJob: (id: string) => void; onGoal: (id: string) => void };
const icons = { idea: Leaf, working: Hammer, review: ClipboardCheck, completed: Check };
const stateName = { idea: 'Assigned next', working: 'Working', review: 'Awaiting review', completed: 'Finished' };
const patrol = [{ x: 50, y: 31 }, { x: 53, y: 53 }, { x: 49, y: 76 }, { x: 46, y: 52 }];
const relativeTime = (date: string) => {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(date)) / 60000));
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`;
};

function CityCharacter({ person, point, job, blocked, selected, names, motion, bubble, onSelect, onConversation }: {
  person: Person; point: CityPoint; job?: Job; blocked: boolean; selected: boolean; names: boolean; motion: boolean;
  bubble?: Bubble; onSelect: () => void; onConversation: (event: Activity) => void;
}) {
  const [position, setPosition] = useState<CityPoint>({ x: 50, y: 54 });
  const [walking, setWalking] = useState(false);
  useEffect(() => {
    setPosition(point); setWalking(true);
    const timer = window.setTimeout(() => setWalking(false), 2900);
    return () => window.clearTimeout(timer);
  }, [point.x, point.y]);
  const appearance = agentAppearance(person.id);
  const StatusIcon = blocked ? CircleHelp : person.canManage ? Crown : job ? icons[job.status] : Coffee;
  const status = blocked ? 'Needs a decision' : person.canManage ? 'Manager' : job ? stateName[job.status] : person.type === 'user' ? 'Workspace owner' : 'No active assignment';
  return <div className={`city-character ${walking && motion ? 'is-walking' : ''} ${job?.status === 'working' && !blocked ? 'is-working' : ''} ${job && ['working', 'idea'].includes(job.status) ? 'works-west' : ''} ${selected ? 'is-selected' : ''} ${person.canManage ? 'is-manager' : ''} ${blocked ? 'is-blocked' : ''}`}
    style={{ left: `${position.x}%`, top: `${position.y}%`, zIndex: Math.round(position.y * 10) + (bubble ? 1000 : 0), '--bot-color': appearance.background, '--bot-accent': appearance.accent, '--bot-delay': `${cityHash(person.id) % 10 * -.2}s` } as CSSProperties}>
    {bubble && <button className={`city-speech ${bubble.replay ? 'is-replay' : ''}`} onClick={() => onConversation(bubble.event)} aria-label={`Open ${person.name}'s ${bubble.replay ? 'replayed' : 'new'} comment`} title={bubble.event.detail}>
      <span className="city-speech-label"><MessageCircle size={10} />{bubble.replay ? 'REPLAY' : 'NEW COMMENT'}</span><span>{bubble.event.detail.slice(0, 110)}{bubble.event.detail.length > 110 ? '…' : ''}</span>
    </button>}
    <button className="city-person" onClick={onSelect} aria-label={`${person.name} · ${status}${job ? ` · ${job.title}` : ''}`} aria-pressed={selected}>
      <span className="city-person-shadow" /><span className="city-person-body"><span className="city-arm left" /><span className="city-arm right" /><span className="city-torso"><i /></span><span className="city-work-tool" aria-hidden="true"><Hammer size={19} strokeWidth={2.5} /></span><span className="city-leg left" /><span className="city-leg right" /></span>
      <span className="city-person-head"><Avatar id={person.id} name={person.name} bot={person.type === 'agent'} manager={person.canManage} /></span>
      <span className="city-state-icon" title={status}><StatusIcon size={11} /></span>
      {(names || selected) && <span className="city-person-name">{person.name}</span>}
    </button>
  </div>;
}

export function CrewCity(props: CityProps) {
  if (!props.project) return <div className="empty-project-state"><Footprints size={36} /><h1>Your city starts with a project.</h1><p>Select a project to watch its crew.</p></div>;
  return <CityWorld key={props.project.id} {...props} project={props.project} />;
}

function CityWorld({ project, projects, people, inbox, onProject, onJob, onGoal }: CityProps & { project: Project }) {
  const jobs = useMemo(() => cityJobs(projects, project), [projects, project]);
  const rootId = project.parentProjectId || project.id;
  const residents = useMemo(() => people.filter(person => person.type === 'user' || person.rootProjectId === rootId).sort((a, b) => a.id.localeCompare(b.id)), [people, rootId]);
  const [events, setEvents] = useState<Activity[]>([]);
  const [bubbles, setBubbles] = useState<Record<string, Bubble>>({});
  const [connection, setConnection] = useState<'loading' | 'live' | 'offline'>('loading');
  const [selection, setSelection] = useState<Selection>(null);
  const [panel, setPanel] = useState<'crew' | 'updates'>('crew');
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [names, setNames] = useState(false);
  const [motion, setMotion] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [theater, setTheater] = useState(false);
  const [time, setTime] = useState(Date.now());
  const [patrolStep, setPatrolStep] = useState(0);
  const cursor = useRef(0);
  const initialized = useRef(false);
  const worldRef = useRef<HTMLElement>(null);
  const blockedIds = new Set((inbox?.requests || []).filter(item => item.request.status === 'pending').map(item => item.job.id));
  const effectiveMotion = motion && !reducedMotion;

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(preference.matches);
    update(); preference.addEventListener('change', update);
    return () => preference.removeEventListener('change', update);
  }, []);
  useEffect(() => { const timer = window.setInterval(() => setTime(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    if (!effectiveMotion) return;
    const timer = window.setInterval(() => setPatrolStep(step => (step + 1) % patrol.length), 10000);
    return () => window.clearInterval(timer);
  }, [effectiveMotion]);
  useEffect(() => {
    if (!theater) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    worldRef.current?.querySelector<HTMLButtonElement>('.city-theater-close')?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTheater(false);
      if (event.key === 'Tab') {
        const controls = [...(worldRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select') || [])].filter(element => element.offsetParent !== null);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('keydown', escape); document.body.style.overflow = previousOverflow; previousFocus?.focus(); };
  }, [theater]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: number;
    async function poll() {
      if (controller.signal.aborted) return;
      try {
        // Drain paginated history before treating anything as a live event.
        // A bounded batch keeps a large project's first sync responsive.
        for (let page = 0; page < 5; page++) {
          const incoming = await api<Activity[]>(`/projects/${project.id}/activity?since=${cursor.current}`, { signal: controller.signal });
          if (controller.signal.aborted) return;
          const newEvents = incoming.filter(event => event.id > cursor.current);
          if (newEvents.length) {
            cursor.current = Math.max(cursor.current, ...newEvents.map(event => event.id));
            setEvents(current => mergeCityActivity(current, newEvents.filter(isCityEvent)));
            if (initialized.current) {
              const recent = newEvents.filter(event => isConversation(event) && Date.now() - Date.parse(event.createdAt) < 60000);
              if (recent.length) setBubbles(current => {
                const next = { ...current };
                for (const event of recent) next[event.actor.id] = { event, until: Date.now() + 18000, replay: false };
                return next;
              });
            }
          }
          if (incoming.length < 200 || !newEvents.length) { initialized.current = true; setConnection('live'); break; }
        }
      } catch { if (!controller.signal.aborted) setConnection('offline'); }
      if (!controller.signal.aborted) timer = window.setTimeout(poll, 5000);
    }
    void poll();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [project.id]);

  const latest = [...events].reverse();
  const activeBubbles = Object.fromEntries(Object.entries(bubbles).filter(([, bubble]) => bubble.until > time));
  const basePoints = new Map(residents.map(person => [person.id, personPoint(person, jobs, residents)]));
  const pointFor = (person: Person): CityPoint => {
    const bubble = activeBubbles[person.id];
    if (bubble) {
      const target = person.canManage ? conversationTarget(bubble.event, residents, jobs) : undefined;
      if (target) { const point = basePoints.get(target.id)!; return { x: point.x + 4, y: point.y + 3 }; }
      const job = jobs.find(item => item.id === bubble.event.jobId);
      if (job) { const point = jobPoint(job, jobs); return { x: point.x + 2, y: point.y + 4 }; }
    }
    return person.canManage && !agentJob(person, jobs) ? patrol[(patrolStep + cityHash(person.id)) % patrol.length] : basePoints.get(person.id)!;
  };
  const visiblePeople = residents.filter(person => {
    const job = agentJob(person, jobs);
    return (!query || `${person.name} ${job?.title || ''}`.toLowerCase().includes(query.toLowerCase())) &&
      (filter === 'all' || filter === 'managers' && person.canManage || filter === 'working' && job?.status === 'working' || filter === 'blocked' && job && blockedIds.has(job.id));
  });
  const selectedPerson = selection?.kind === 'person' ? residents.find(person => person.id === selection.id) : undefined;
  const selectedJob = selection?.kind === 'job' ? jobs.find(job => job.id === selection.id) : undefined;
  const selectedDistrict = selection?.kind === 'district' ? cityDistricts.find(district => district.id === selection.id) : undefined;
  const selectedPersonJobs = selectedPerson ? jobs.filter(job => job.assignee?.id === selectedPerson.id || job.assignedAgentId === selectedPerson.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) : [];
  const selectedEvents = selectedPerson ? latest.filter(event => event.actor.id === selectedPerson.id) : latest;
  const showJob = (id: string) => { setTheater(false); onJob(id); };
  const openConversation = (event: Activity) => { setTheater(false); if (event.jobId) onJob(event.jobId); else if (event.goalId) onGoal(event.goalId); };
  const replay = (event: Activity) => {
    setBubbles(current => ({ ...current, [event.actor.id]: { event, until: Date.now() + 18000, replay: true } }));
    setSelection({ kind: 'person', id: event.actor.id });
    setTime(Date.now());
  };
  const eventList = (items: Activity[], count = 8) => items.slice(0, count).map(event => <div className="city-event" key={event.id}>
    <Avatar id={event.actor.id} name={event.actor.name} bot={event.actor.type === 'agent'} size="small" />
    <div><strong>{event.actor.name}</strong><small>{eventLabel(event)} · {relativeTime(event.createdAt)}</small><p>{event.detail}</p>
      <div className="city-event-actions">{isConversation(event) && residents.some(person => person.id === event.actor.id) && <button onClick={() => replay(event)}><RotateCcw size={11} /> Replay bubble</button>}{(event.jobId || event.goalId) && <button onClick={() => openConversation(event)}>Open thread <ArrowRight size={11} /></button>}</div>
    </div>
  </div>);
  const jobList = (items: Job[]) => items.map(job => <button className="city-job-row" key={job.id} onClick={() => { setSelection({ kind: 'job', id: job.id }); }}>
    <span className={`city-job-dot ${job.status}`} /><span><strong>{job.title}</strong><small>{blockedIds.has(job.id) ? 'Needs a decision' : stateName[job.status]} · {job.assignee?.name || 'Unclaimed'}</small></span><ArrowRight size={13} />
  </button>);
  const agentCount = residents.filter(person => person.type === 'agent').length;

  return <section ref={worldRef} role={theater ? 'dialog' : undefined} aria-modal={theater ? true : undefined} aria-label={theater ? 'Crew City wide view' : undefined} className={`crew-city ${theater ? 'city-theater' : ''} ${effectiveMotion ? '' : 'city-still'}`}>
    <header className="city-header"><div><div className="city-eyebrow"><Sparkles size={12} /> A LITTLE WORLD. REAL WORK.</div><h1>Crew City<span>.</span></h1><p>Your crew, a little more alive. Follow the work as it happens.</p></div>
      <div className={`city-live-status ${connection}`} role="status"><i />{connection === 'live' ? 'Connected · updates every 5s' : connection === 'offline' ? 'Reconnecting · last known activity' : 'Syncing activity…'}</div>
    </header>
    <div className="city-toolbar"><label className="city-project-picker"><Flag size={14} /><select aria-label="Crew City project" value={project.id} onChange={event => onProject(event.target.value)}>{projects.map(item => <option key={item.id} value={item.id}>{item.parentProjectId ? '↳ ' : ''}{item.name}</option>)}</select></label>
      <label className="city-filter"><Users size={14} /><select aria-label="Filter city crew" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All crew</option><option value="working">Working</option><option value="blocked">Needs a decision</option><option value="managers">Managers</option></select></label>
      <div className="city-toolbar-spacer" /><button className={names ? 'active' : ''} onClick={() => setNames(!names)} aria-pressed={names}>Names</button>
      <button onClick={() => setMotion(!motion)} aria-pressed={!motion} disabled={reducedMotion} title={reducedMotion ? 'Reduced motion follows your device preference' : 'Pause decorative movement; updates continue'}>{effectiveMotion ? <Pause size={13} /> : <Play size={13} />}{effectiveMotion ? 'Pause motion' : 'Motion paused'}</button>
      <button onClick={() => setTheater(!theater)} aria-pressed={theater}><Focus size={14} />{theater ? 'Exit wide view' : 'Wide view'}</button>
    </div>
    <div className="city-layout"><div className="city-map-card"><div className="city-map-top"><span><span className="city-map-dot" />{project.name}</span><small>{agentCount} agents · {jobs.length} jobs</small></div>
      <div className="city-map-viewport"><div className="city-stage" style={{ width: `${zoom * 100}%` }} aria-label="Interactive Crew City map">
        <img className="city-scenery" src="/crew-city/city-island.png" alt="An illustrated island city with an idea greenhouse, orange workshop, purple review lab, and green completion depot around an open plaza" draggable="false" />
        <div className="city-sunbeams" aria-hidden="true" /><div className="city-motes" aria-hidden="true"><i /><i /><i /><i /><i /></div>
        <span className="city-plaza-label">CREW PLAZA</span>
        {cityDistricts.map(district => { const Icon = icons[district.id]; return <button className={`city-district ${selection?.id === district.id ? 'active' : ''}`} key={district.id} style={{ left: `${district.x}%`, top: `${district.y}%`, '--district-color': district.color } as CSSProperties} onClick={() => setSelection({ kind: 'district', id: district.id })} aria-label={`${district.name}: ${jobs.filter(job => job.status === district.id).length} jobs`}><Icon size={14} /><span>{district.name}</span><b>{jobs.filter(job => job.status === district.id).length}</b></button>; })}
        {cityDistricts.flatMap(district => districtSiteJobs(jobs, district.id).map(job => <CityJobSite key={job.id} job={job} point={jobPoint(job, jobs)} blocked={blockedIds.has(job.id)} selected={selection?.kind === 'job' && selection.id === job.id} fresh={time - Date.parse(job.createdAt) >= 0 && time - Date.parse(job.createdAt) < 60000} onSelect={() => setSelection({ kind: 'job', id: job.id })} />))}
        {visiblePeople.map(person => { const job = agentJob(person, jobs); return <CityCharacter key={person.id} person={person} point={pointFor(person)} job={job} blocked={!!job && blockedIds.has(job.id)} selected={selection?.kind === 'person' && selection.id === person.id} names={names} motion={effectiveMotion} bubble={activeBubbles[person.id]} onSelect={() => setSelection({ kind: 'person', id: person.id })} onConversation={openConversation} />; })}
        {!agentCount && <div className="city-empty-world"><Sparkles size={20} /><strong>A city waiting for its crew.</strong><span>Connect agents to this project and they’ll appear here.</span></div>}
        <div className="city-map-sign"><Footprints size={13} /><span>{Object.values(activeBubbles).some(bubble => bubble.replay) ? 'Replaying a recorded comment' : 'Little footsteps. Real milestones.'}</span></div>
      </div></div>
      <div className="city-map-bottom"><div className="city-legend"><span><Hammer size={12} /> Working</span><span><ClipboardCheck size={12} /> Review</span><span><CircleHelp size={12} /> Needs you</span><span><Crown size={12} /> Manager</span></div>
        <div className="city-zoom"><button aria-label="Zoom out city" disabled={zoom <= 1} onClick={() => setZoom(value => Math.max(1, value - .25))}><ZoomOut size={14} /></button><button aria-label="Reset city zoom" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button><button aria-label="Zoom in city" disabled={zoom >= 1.75} onClick={() => setZoom(value => Math.min(1.75, value + .25))}><ZoomIn size={14} /></button></div>
      </div><p className="city-disclaimer">Job states and comments drive the city. Walking and construction are decorative; they don’t measure progress or show whether an agent is online.</p>
    </div>
    <aside className="city-inspector" aria-label="City crew and activity"><div className="city-panel-tabs"><button className={panel === 'crew' ? 'active' : ''} onClick={() => { setPanel('crew'); setSelection(null); }}><Users size={14} /> Crew</button><button className={panel === 'updates' ? 'active' : ''} onClick={() => { setPanel('updates'); setSelection(null); }}><MessageCircle size={14} /> Updates <small>{events.length}</small></button></div>
      {selection ? <div className="city-inspection"><button className="city-back" onClick={() => setSelection(null)}><ChevronLeft size={13} /> Back to {panel}</button>
        {selectedPerson ? <><div className="city-person-detail"><Avatar id={selectedPerson.id} name={selectedPerson.name} bot={selectedPerson.type === 'agent'} manager={selectedPerson.canManage} size="large" /><div><h2>{selectedPerson.name}</h2><small>{selectedPerson.canManage ? 'Manager · follows conversations' : selectedPerson.type === 'user' ? 'Workspace owner' : 'Project agent'}</small></div></div><h3>Assignments <span>{selectedPersonJobs.length}</span></h3>{selectedPersonJobs.length ? jobList(selectedPersonJobs) : <p className="city-muted">No assigned job. You’ll find this crew member in the plaza.</p>}<h3>Latest activity</h3>{selectedEvents.length ? eventList(selectedEvents, 4) : <p className="city-muted">Their next update will appear here.</p>}</> : selectedJob ? <><div className={`city-detail-status ${selectedJob.status}`}>{stateName[selectedJob.status]}</div><h2>{selectedJob.title}</h2><p className="city-job-description">{selectedJob.body || 'Open the job for the full brief and conversation.'}</p>{selectedJob.assignee && <div className="city-detail-assignee"><Avatar id={selectedJob.assignee.id} name={selectedJob.assignee.name} bot={selectedJob.assignee.type === 'agent'} /><span>{selectedJob.assignee.name}</span></div>}{blockedIds.has(selectedJob.id) && <div className="city-blocker"><CircleHelp size={16} />Waiting for a human decision.</div>}<button className="city-open-job" onClick={() => showJob(selectedJob.id)}>Open job & conversation <ArrowRight size={14} /></button><h3>Job activity</h3>{eventList(latest.filter(event => event.jobId === selectedJob.id), 5)}</> : selectedDistrict ? <><div className="city-eyebrow">CITY DISTRICT</div><h2>{selectedDistrict.name}</h2><p className="city-muted">{selectedDistrict.label} · {jobs.filter(job => job.status === selectedDistrict.id).length} jobs</p>{jobList(jobs.filter(job => job.status === selectedDistrict.id))}{!jobs.some(job => job.status === selectedDistrict.id) && <p className="city-muted">No jobs here yet.</p>}</> : <p className="city-muted">This crew member is no longer in the current roster.</p>}
      </div> : panel === 'crew' ? <><div className="city-crew-intro"><div className="city-eyebrow">THE LOCALS</div><h2>Meet your crew</h2><p>Pick a bot to follow its work.</p></div><label className="city-crew-search"><Search size={13} /><input aria-label="Find a city crew member" placeholder="Find a bot or job…" value={query} onChange={event => setQuery(event.target.value)} /></label><div className="city-resident-list">{visiblePeople.map(person => { const job = agentJob(person, jobs); return <button key={person.id} className="city-resident-row" onClick={() => setSelection({ kind: 'person', id: person.id })}><Avatar id={person.id} name={person.name} bot={person.type === 'agent'} manager={person.canManage} /><span><strong>{person.name}</strong><small>{job && blockedIds.has(job.id) ? 'Needs a decision' : person.canManage ? 'Manager' : job ? stateName[job.status] : person.type === 'user' ? 'Workspace owner' : 'In the plaza'}</small></span>{person.canManage ? <Crown size={13} /> : <ArrowRight size={13} />}</button>; })}{!visiblePeople.length && <p className="city-muted">No crew members match this view.</p>}</div><div className="city-howto"><MessageCircle size={16} /><div><strong>Catch a conversation</strong><p>New comments float over the crew. Find an earlier comment under Updates and replay its bubble.</p></div></div></> : <div className="city-updates"><div className="city-crew-intro"><div className="city-eyebrow">THE CITY JOURNAL</div><h2>Real work, little moments</h2><p>Recent reported activity. Replay a comment to see where the conversation happened.</p></div>{events.length ? eventList(latest, 25) : <p className="city-muted">No activity yet. The city will wake up when your crew posts an update.</p>}</div>}
    </aside></div>
    {theater && <button className="city-theater-close" onClick={() => setTheater(false)} aria-label="Close city wide view"><X size={18} /></button>}
  </section>;
}
