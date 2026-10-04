import type { Activity, Job, JobStatus, Person, Project } from './types';

export type CityPoint = { x: number; y: number };
export const cityDistricts: { id: JobStatus; name: string; label: string; x: number; y: number; color: string }[] = [
  { id: 'working', name: 'Workshop', label: 'Working', x: 23, y: 32, color: '#eaa259' },
  { id: 'review', name: 'Review lab', label: 'In review', x: 79, y: 32, color: '#ac96dc' },
  { id: 'idea', name: 'Idea garden', label: 'Open ideas', x: 20, y: 77, color: '#dfba51' },
  { id: 'completed', name: 'Done depot', label: 'Completed', x: 80, y: 82, color: '#65b69c' },
];
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
    // Overflow jobs gather by their district, never on another job's building.
    if (job.status === 'completed') {
      const overflow = jobs.filter(item => item.status === job.status && !districtJobs.some(site => site.id === item.id)).sort((a, b) => a.id.localeCompare(b.id));
      const place = Math.max(0, overflow.findIndex(item => item.id === job.id));
      return { x: 57 + (place % 6) * 5.8, y: 82 + Math.floor(place / 6) * 6 };
    }
    const district = cityDistricts.find(item => item.id === job.status)!;
    return { x: district.x - 3 + cityHash(job.id) % 7, y: district.y + 9 };
  }
  const x = (job.status === 'working' || job.status === 'idea') ? 28 : 60;
  const y = (job.status === 'working' || job.status === 'review') ? 39 : 64;
  return { x: x + (slot % 3) * 8, y: y + Math.floor(slot / 3) * 10 };
}
export function personPoint(person: Person, jobs: Job[], people: Person[]): CityPoint {
  const job = agentJob(person, jobs);
  if (job) {
    const point = jobPoint(job, jobs);
    const hash = cityHash(person.id);
    const side = job.status === 'working' || job.status === 'idea' ? -1 : 1;
    return { x: point.x + side * (3.7 + (hash % 2) * .3), y: point.y + 5 + (hash % 2) };
  }
  if (person.canManage) return { x: 50, y: 29 };
  const idle = people.filter(item => !agentJob(item, jobs) && !item.canManage).sort((a, b) => a.id.localeCompare(b.id));
  const slot = Math.max(0, idle.findIndex(item => item.id === person.id));
  // Stagger extra rows across the open plaza instead of placing everyone on one point.
  if (slot < 14) return { x: 49 + (slot % 2) * 6, y: 38 + Math.floor(slot / 2) * 7 };
  const overflow = slot - 14;
  return { x: 40 + (overflow % 6) * 6, y: 86 + Math.floor(overflow / 6) * 6 };
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
