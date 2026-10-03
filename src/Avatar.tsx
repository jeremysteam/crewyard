import { agentAppearance } from './agentAppearance';
import './avatars.css';

const ink = '#193139';
const shell = '#f7f6e9';

export function AgentPortrait({ design, background, accent }: { design: number; background: string; accent: string }) {
  const shape = Math.floor(design / 5);
  const face = design % 5;
  const head = [
    <rect x="14" y="19" width="36" height="29" rx="13" />,
    <rect x="14" y="19" width="36" height="29" rx="7" />,
    <path d="M22 18H42L51 29V40L42 49H22L13 40V29Z" />,
    <path d="M14 35C14 12 50 12 50 35V43Q50 49 43 49H21Q14 49 14 43Z" />,
    <rect x="17" y="15" width="30" height="35" rx="15" />,
  ][shape];
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
    <rect width="64" height="64" fill={background} />
    <circle cx="53" cy="11" r="18" fill="#fff" opacity=".12" />
    <circle cx="9" cy="58" r="19" fill={ink} opacity=".08" />
    <g stroke={ink} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round">
      <path d="M11 66V60Q11 50 24 50H40Q53 50 53 60V66" fill={shell} />
      <path d="M27 47V53Q32 57 37 53V47" fill={accent} />
      {face === 0 && <><path d="M32 19V11" /><circle cx="32" cy="9" r="3" fill={accent} /><rect x="9" y="29" width="5" height="10" rx="2" fill={accent} /><rect x="50" y="29" width="5" height="10" rx="2" fill={accent} /></>}
      {face === 1 && <><path d="M23 20L19 13M41 20L45 13" /><circle cx="18" cy="11" r="3" fill={accent} /><circle cx="46" cy="11" r="3" fill={accent} /></>}
      {face === 2 && <><path d="M17 25V13L27 19M47 25V13L37 19" fill={accent} /><path d="M9 31V39M55 31V39" strokeWidth="4" /></>}
      {face === 3 && <><path d="M14 31V26C14 8 50 8 50 26V31" fill="none" /><rect x="8" y="28" width="7" height="13" rx="3" fill={accent} /><rect x="49" y="28" width="7" height="13" rx="3" fill={accent} /></>}
      {face === 4 && <><path d="M23 20L21 10L28 14L32 7L36 14L43 10L41 20" fill={accent} /></>}
      <g fill={shell}>{head}</g>
      {face === 0 && <><circle cx="24" cy="32" r="4" fill={ink} stroke="none" /><circle cx="40" cy="32" r="4" fill={ink} stroke="none" /><circle cx="25" cy="31" r="1.2" fill={accent} stroke="none" /><circle cx="41" cy="31" r="1.2" fill={accent} stroke="none" /><path d="M27 41Q32 45 37 41" fill="none" /></>}
      {face === 1 && <><rect x="19" y="26" width="26" height="13" rx="6" fill={ink} /><path d="M24 32H28M36 32H40" stroke={accent} strokeWidth="3" /><path d="M29 44H35" /></>}
      {face === 2 && <><circle cx="32" cy="32" r="9" fill={ink} /><circle cx="32" cy="32" r="4" fill={accent} stroke="none" /><circle cx="33" cy="30" r="1.6" fill={shell} stroke="none" /><path d="M28 45H36" /></>}
      {face === 3 && <><path d="M21 33Q25 26 29 33M35 33Q39 26 43 33" fill="none" strokeWidth="3" /><path d="M27 41Q32 47 37 41Z" fill={ink} /><circle cx="19" cy="39" r="2" fill={accent} stroke="none" /><circle cx="45" cy="39" r="2" fill={accent} stroke="none" /></>}
      {face === 4 && <><rect x="20" y="27" width="9" height="10" rx="3" fill={ink} /><rect x="35" y="27" width="9" height="10" rx="3" fill={ink} /><path d="M24 31V33M39 31V33" stroke={accent} strokeWidth="2" /><path d="M28 43H36" /><path d="M32 41V45" /></>}
      {shape === 0 && <circle cx="32" cy="61" r="2.5" fill={accent} />}
      {shape === 1 && <path d="M27 59H37V64H27Z" fill={accent} />}
      {shape === 2 && <path d="M32 57L36 61L32 65L28 61Z" fill={accent} />}
      {shape === 3 && <path d="M26 60H38M29 64H35" />}
      {shape === 4 && <path d="M30 57L27 62H33L31 66L38 60H32L34 57Z" fill={accent} strokeWidth="1.4" />}
    </g>
  </svg>;
}

export function Avatar({ id, name, bot = false, size = 'normal' }: { id?: string; name: string; bot?: boolean; size?: 'normal' | 'small' | 'large' }) {
  const appearance = bot ? agentAppearance(id || name) : null;
  const initials = name.split(/[\s_-]+/).map(word => word[0]).slice(0, 2).join('').toUpperCase();
  return <span className={`avatar ${bot ? 'avatar-bot agent-portrait' : ''} ${size === 'small' ? 'avatar-small' : size === 'large' ? 'avatar-large' : ''}`} title={name} role="img" aria-label={`${name}'s profile picture`}>
    {appearance ? <AgentPortrait {...appearance} /> : initials}
  </span>;
}
