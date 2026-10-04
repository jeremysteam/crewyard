import type { Activity, Job, JobStatus, Person, Project } from './types';

export type CityPoint = { x: number; y: number };
export const cityDistricts: { id: JobStatus; name: string; label: string; x: number; y: number; color: string }[] = [
  { id: 'working', name: 'Workshop', label: 'Working', x: 23, y: 32, color: '#eaa259' },
  { id: 'review', name: 'Review lab', label: 'In review', x: 79, y: 32, color: '#ac96dc' },
  { id: 'idea', name: 'Idea garden', label: 'Open ideas', x: 20, y: 77, color: '#dfba51' },
  { id: 'completed', name: 'Done depot', label: 'Completed', x: 80, y: 82, color: '#65b69c' },
];

// A conservative, convex outline of the illustrated pavement. Matching easing
// on both coordinates keeps the entire segment between two stops on this ground.
export const cityWalkableArea: readonly CityPoint[] = [
  { x: 30, y: 34 }, { x: 67, y: 34 }, { x: 72, y: 44 },
  { x: 60, y: 70 }, { x: 55, y: 77 }, { x: 45, y: 77 }, { x: 29, y: 51 },
];
export function isCityWalkable(point: CityPoint) {
  return Number.isFinite(point.x) && Number.isFinite(point.y) && cityWalkableArea.every((a, index) => {
    const b = cityWalkableArea[(index + 1) % cityWalkableArea.length];
    return (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x) >= -1e-8;
  });
}
export function cityWalkablePoint(point: CityPoint): CityPoint {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return { x: 50, y: 54 };
  if (isCityWalkable(point)) return point;
  let closest = { x: 50, y: 54 }, distance = Infinity;
  cityWalkableArea.forEach((a, index) => {
    const b = cityWalkableArea[(index + 1) % cityWalkableArea.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy)));
    const candidate = { x: a.x + t * dx, y: a.y + t * dy };
    const squared = (candidate.x - point.x) ** 2 + (candidate.y - point.y) ** 2;
    if (squared < distance) { closest = candidate; distance = squared; }
  });
  return closest;
}
export function citySiteStand(person: Person, job: Job, jobs: Job[], secondSide = false): CityPoint {
  const point = jobPoint(job, jobs);
  const side = job.status === 'working' || job.status === 'completed' ? -1 : 1;
  return cityWalkablePoint({ x: point.x + side * (3.7 + cityHash(person.id) % 2 * .3), y: point.y + (secondSide ? 7 : 5) + cityHash(person.id) % 2 });
}

export function cityHash(value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return hash >>> 0;
}
export function cityProjects(projects: Project[], selected: Project) {
  return projects.filter(project => project.id === selected.id || project.parentProjectId === selected.id);
}
export function cityJobs(projects: Project[], selected: Project) {
  return cityProjects(projects, selected).flatMap(project => project.jobs);
}
export function agentJob(person: Person, jobs: Job[]) {
  const priority: Record<JobStatus, number> = { working: 0, review: 1, idea: 2, completed: 3 };
  return jobs.filter(job => job.assignee?.id === person.id || job.assignedAgentId === person.id)
    .sort((a, b) => priority[a.status] - priority[b.status] || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))[0];
}
// Keep new jobs visible in the small plots; the district inspector holds the full list.
export function districtSiteJobs(jobs: Job[], status: JobStatus) {
  return jobs.filter(job => job.status === status)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    .slice(0, 6).sort((a, b) => a.id.localeCompare(b.id));
}
export function jobPoint(job: Job, jobs: Job[]): CityPoint {
  const districtJobs = districtSiteJobs(jobs, job.status);
  const slot = districtJobs.findIndex(item => item.id === job.id);
  if (slot < 0) {
    const overflow = jobs.filter(item => item.status === job.status && !districtJobs.some(site => site.id === item.id)).sort((a, b) => a.id.localeCompare(b.id));
    const place = Math.max(0, overflow.findIndex(item => item.id === job.id));
    // Extra jobs use inland staging spots rather than the depot's cliff edge.
    return cityWalkablePoint({ x: 42 + (place % 5) * 4.8, y: 54 + Math.floor(place / 5) * 5 });
  }
  const row = Math.floor(slot / 3), column = slot % 3;
  const plots = {
    working: { x: row ? 36 : 34, y: row ? 48 : 39, spacing: 6 },
    review: { x: row ? 53 : 54, y: row ? 48 : 39, spacing: row ? 5 : 6 },
    idea: { x: row ? 40 : 34, y: row ? 67 : 59, spacing: 5 },
    completed: { x: row ? 52 : 58, y: row ? 67 : 58, spacing: 5 },
  };
  const plot = plots[job.status];
  return cityWalkablePoint({ x: plot.x + column * plot.spacing, y: plot.y });
}
export function personPoint(person: Person, jobs: Job[], people: Person[]): CityPoint {
  const job = agentJob(person, jobs);
  if (job) return citySiteStand(person, job, jobs);
  if (person.canManage) return { x: 50, y: 34 };
  const idle = people.filter(item => !agentJob(item, jobs) && !item.canManage).sort((a, b) => a.id.localeCompare(b.id));
  const slot = Math.max(0, idle.findIndex(item => item.id === person.id));
  return cityWalkablePoint({ x: 40 + (slot % 5) * 4.5, y: 43 + Math.floor(slot / 5) * 6 });
}
export function conversationTarget(event: Activity, people: Person[], jobs: Job[]) {
  // Only explicit mentions, or the actual assignee of the commented job, imply a visit.
  const mentions = [...event.detail.matchAll(/@([\w-]+)/g)].map(match => match[1].toLowerCase());
  const mentioned = people.find(person => person.id !== event.actor.id && mentions.some(mention => mention === person.handle.toLowerCase() || mention === person.name.toLowerCase()));
  if (mentioned) return mentioned;
  const assignee = jobs.find(job => job.id === event.jobId)?.assignee;
  return assignee && assignee.id !== event.actor.id ? people.find(person => person.id === assignee.id) : undefined;
}
export function mergeCityActivity(existing: Activity[], incoming: Activity[], limit = 80) {
  const byId = new Map(existing.map(event => [event.id, event]));
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()].sort((a, b) => a.id - b.id).slice(-limit);
}
export function isCityEvent(event: Activity) {
  return event.action.startsWith('job.') || event.action === 'goal.comment';
}
export function isConversation(event: Activity) {
  return ['job.comment', 'goal.comment', 'job.requested', 'job.request_answered'].includes(event.action);
}
export function eventLabel(event: Activity) {
  const labels: Record<string, string> = {
    'job.comment': 'left a comment', 'goal.comment': 'joined a conversation', 'job.claimed': 'claimed a job',
    'job.assigned': 'assigned a job', 'job.moved': 'moved a job', 'job.created': 'opened a job',
    'job.requested': 'asked for a decision', 'job.request_answered': 'answered a question',
    'job.review_decided': 'reviewed a submission', 'job.request_cancelled': 'closed a question',
    'job.updated': 'updated a job', 'job.voted': 'voted on a job',
  };
  return labels[event.action] || 'shared an update';
}
