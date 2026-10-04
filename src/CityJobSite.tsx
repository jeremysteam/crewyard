import type { CSSProperties } from 'react';
import { Check, CircleHelp, ClipboardCheck, Hammer, Leaf } from 'lucide-react';
import { cityHash, type CityPoint } from './crewCityModel';
import type { Job } from './types';
import './city-job-site.css';

// Extruded vector solids share the island's camera angle and stay sharp at every zoom.
function Block({ x = 40, y = 68, width = 17, depth = 14, height = 25, glass = false }: {
  x?: number; y?: number; width?: number; depth?: number; height?: number; glass?: boolean;
}) {
  const left = `${x - width},${y - width * .5}`;
  const right = `${x + depth},${y - depth * .5}`;
  const back = `${x - width + depth},${y - (width + depth) * .5}`;
  const topLeft = `${x - width},${y - width * .5 - height}`;
  const topRight = `${x + depth},${y - depth * .5 - height}`;
  const topBack = `${x - width + depth},${y - (width + depth) * .5 - height}`;
  return <g className={glass ? 'site-block site-glass' : 'site-block'} stroke="#385651" strokeWidth="1" strokeLinejoin="round">
    <polygon className="site-face-left" points={`${x},${y} ${left} ${topLeft} ${x},${y - height}`} />
    <polygon className="site-face-right" points={`${x},${y} ${right} ${topRight} ${x},${y - height}`} />
    <polygon className="site-face-top" points={`${x},${y - height} ${topLeft} ${topBack} ${topRight}`} />
    <path className="site-window" d={`M${x - width * .72},${y - height + 5 - width * .36}v7l5,2.5v-7z M${x + 4},${y - height + 4 - 2}v7l5,-2.5v-7z`} strokeWidth=".6" />
  </g>;
}

const palettes = [
  ['#efbd77', '#c98d51', '#ffe0a5'], ['#a3c9ed', '#668fb7', '#d0e9ff'],
  ['#bdadeb', '#8b74b7', '#e3d6ff'], ['#94cfae', '#579777', '#c8edd5'],
];
const kinds = ['workshop', 'observatory', 'studio', 'greenhouse'];
const stageNames = { idea: 'Foundation ready', working: 'Under construction', review: 'Ready for inspection', completed: 'Finished building' };

export function CityJobSite({ job, point, blocked, selected, fresh, onSelect }: {
  job: Job; point: CityPoint; blocked: boolean; selected: boolean; fresh: boolean; onSelect: () => void;
}) {
  const variant = cityHash(job.id) % kinds.length;
  const [light, shade, roof] = palettes[variant];
  const state = blocked ? 'Construction paused · needs a decision' : stageNames[job.status];
  const Status = blocked ? CircleHelp : job.status === 'completed' ? Check : job.status === 'review' ? ClipboardCheck : job.status === 'working' ? Hammer : Leaf;
  return <button className={`city-job-site ${job.status} site-${kinds[variant]} ${blocked ? 'site-blocked' : ''} ${selected ? 'active' : ''} ${fresh ? 'site-fresh' : ''}`}
    style={{ left: `${point.x}%`, top: `${point.y}%`, zIndex: Math.round(point.y * 10), '--site-light': light, '--site-shade': shade, '--site-roof': roof, '--site-delay': `${cityHash(job.id) % 7 * -.7}s` } as CSSProperties}
    onClick={onSelect} aria-label={`Task station: ${job.title} · ${state}`} aria-pressed={selected} title={`${job.title} — ${state}`}>
    <svg className="city-site-art" viewBox="0 0 80 96" aria-hidden="true">
      <ellipse className="site-shadow" cx="40" cy="76" rx="29" ry="12" />
      <path className="site-pad" d="M10 69L39 54L70 69L41 85Z M10 69v4l31 16 29-16v-4M41 85v4" />
      <path className="site-plan" d="M22 68l18-9 18 9-18 9z M31 63l18 9M31 72l18-9" />
      <g className="site-building">
        <Block height={variant === 1 ? 32 : 24} glass={variant === 3} />
        {variant === 0 && <><Block x={31} y={53} width={5} depth={5} height={13} /><path className="site-door" d="M36 65v-10l4 2v10" /></>}
        {variant === 1 && <><ellipse className="site-dome" cx="39" cy="30" rx="13" ry="7" /><path className="site-antenna" d="M39 24v-9m-4 4h8" /></>}
        {variant === 2 && <><Block x={40} y={43} width={11} depth={9} height={10} /><path className="site-sign" d="M32 45l5 2v5l-5-2z" /></>}
        {variant === 3 && <><path className="site-glass-roof" d="M23 37l15-12 16 12-14 7z" /><path className="site-leaves" d="M43 57v-10m0 5q-9 0-7-6 7 0 7 6m0-3q7-9 10-4-2 6-10 4" /></>}
      </g>
      <g className="site-scaffold" fill="none" stroke="#d8ac66" strokeWidth="1.8" strokeLinecap="round">
        <path d="M19 71V36l20 10v36M19 50l20 10M19 61l20 10M20 38l18 31M20 61l18-14M39 46l20-10v35M39 60l20-10M39 71l20-10M40 48l18 22M40 71l18-32" />
        <path className="site-ladder" d="M14 72V47m5 28V50M14 53l5 3M14 60l5 3M14 67l5 3" />
      </g>
      <g className="site-crane" fill="none" stroke="#6b7765" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M64 65V15M60 65V17M60 59l4-9-4-9 4-9-4-9M56 66h13M26 18l42-6v6l-42 5z" />
        <g className="site-hoist"><path d="M30 22v18m-3 0q0 6 5 3" /><path className="site-cargo" d="M25 47l6-3 7 3v5l-7 4-6-4z" /></g>
      </g>
      <g className="site-materials"><Block x={16} y={76} width={5} depth={5} height={5} /><Block x={59} y={80} width={5} depth={5} height={4} /></g>
      <g className="site-sparks" stroke="#fff2b1" strokeWidth="2" strokeLinecap="round"><path d="M20 53l-4-4m5 7h-7m9-2v-6" /></g>
      <g className="site-finished-flag"><path d="M61 68V43" stroke="#607461" strokeWidth="1.5" /><path d="M61 43l12 3v10l-12-3z" fill="#80c69a" stroke="#4a8063" /><path d="M64 49l2 2 4-3" stroke="#fff" strokeWidth="1.5" fill="none" /></g>
    </svg>
    <span className="city-site-state"><Status size={10} /></span>
    <span className="city-site-caption">{fresh ? 'NEW JOB' : blocked ? 'PAUSED' : job.status === 'working' ? 'BUILDING' : job.status === 'review' ? 'INSPECT' : job.status === 'idea' ? 'PLANNED' : 'DONE'}</span>
  </button>;
}
