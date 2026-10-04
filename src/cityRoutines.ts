import { agentJob, cityHash, citySiteStand, cityWalkablePoint, personPoint, type CityPoint } from './crewCityModel';
import type { Job, Person } from './types';

export type CityAction = 'build' | 'carry' | 'collect' | 'review' | 'plan' | 'inspect' | 'manage' | 'rest' | 'wait';
export type CityRoutine = { point: CityPoint; job?: Job; action: CityAction; label: string };
const owns = (person: Person, job: Job) => job.assignee?.id === person.id || job.assignedAgentId === person.id;
const inside = cityWalkablePoint;
const atSite = citySiteStand;

// Choreography uses existing assignments. These poses never change job state.
export function cityRoutine(person: Person, jobs: Job[], people: Person[], blocked: ReadonlySet<string>, elapsed: number): CityRoutine {
  const home = personPoint(person, jobs, people);
  if (person.type === 'user') return { point: home, job: agentJob(person, jobs), action: 'rest', label: 'Workspace owner' };
  const seconds = Math.max(0, Math.floor(elapsed)) + cityHash(person.id) % 36;
  if (person.canManage) {
    const visits = jobs.filter(job => job.status === 'working' || job.status === 'review').sort((a, b) => a.id.localeCompare(b.id));
    const step = Math.floor(seconds / 12);
    const job = visits[step % visits.length];
    if (job && seconds % 12 < 8) return { point: atSite(person, job, jobs, true), job, action: 'manage', label: 'Checking on the crew' };
    const paths = [{ x: 48, y: 34 }, { x: 52, y: 53 }, { x: 49, y: 75 }, { x: 46, y: 52 }];
    return { point: inside(paths[step % paths.length]), action: 'manage', label: 'Making the rounds' };
  }
  const owned = jobs.filter(job => owns(person, job)).sort((a, b) => a.id.localeCompare(b.id));
  const working = owned.filter(job => job.status === 'working' && !blocked.has(job.id));
  if (working.length) {
    const job = working[Math.floor(seconds / 36) % working.length];
    const phase = seconds % 36;
    if (phase < 14) return { point: atSite(person, job, jobs), job, action: 'build', label: 'Assembling at the job site' };
    if (phase < 20) return { point: inside({ x: 45 + cityHash(person.id) % 9, y: 53 + cityHash(job.id) % 5 }), job, action: 'carry', label: 'Carrying parts to the job' };
    if (phase < 26) return { point: inside({ x: 46 + cityHash(person.id) % 4, y: 68 + cityHash(person.id) % 2 }), job, action: 'collect', label: 'Picking up materials' };
    return { point: atSite(person, job, jobs, true), job, action: 'build', label: 'Fitting the next piece' };
  }
  const available = owned.filter(job => !blocked.has(job.id));
  if (available.length) {
    const step = Math.floor(seconds / 26);
    const phase = seconds % 26;
    const job = available[(step + (phase >= 18 ? 1 : 0)) % available.length];
    if (phase >= 12 && phase < 18) return { point: inside({ x: 46 + cityHash(person.id) % 10, y: 53 + cityHash(job.id) % 12 }), job, action: 'carry', label: available.length > 1 ? 'Heading to the next assignment' : 'Taking a short walk' };
    const action = job.status === 'idea' ? 'plan' : job.status === 'review' ? 'review' : 'inspect';
    const label = action === 'plan' ? 'Sketching the next steps' : action === 'review' ? 'Checking the handoff' : 'Looking over finished work';
    return { point: atSite(person, job, jobs, phase >= 18), job, action, label };
  }
  const waiting = owned.find(job => blocked.has(job.id));
  if (waiting) return { point: atSite(person, waiting, jobs), job: waiting, action: 'wait', label: 'Waiting for a decision' };
  // Unassigned agents stretch their legs without appearing to take somebody else's job.
  const stroll = Math.floor(seconds / 7) % 4;
  const offsets = [{ x: -1.5, y: -3 }, { x: 2, y: 0 }, { x: 1, y: 3 }, { x: -2, y: 1 }];
  return { point: inside({ x: home.x + offsets[stroll].x, y: home.y + offsets[stroll].y }), action: 'rest', label: 'Between assignments · stretching legs' };
}
