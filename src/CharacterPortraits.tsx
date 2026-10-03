import type { ReactNode } from 'react';

type Colors = { design: number; background: string; accent: string };
const ink = '#193139';

function Frame({ background, children }: { background: string; children: ReactNode }) {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
    <rect width="64" height="64" fill={background} />
    <circle cx="53" cy="11" r="18" fill="#fff" opacity=".12" />
    <circle cx="9" cy="58" r="19" fill={ink} opacity=".08" />
    <g stroke={ink} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round">{children}</g>
  </svg>;
}

export function DinosaurPortrait({ design, background, accent }: Colors) {
  const skin = `hsl(${105 + design * 19} 48% 73%)`;
  return <Frame background={background}>
    {design === 0 && <>
      <path d="M14 66V45Q7 26 23 21Q29 10 43 18L54 25V41Q51 49 39 47L40 66" fill={skin} />
      <path d="M18 20L20 14L26 18M17 28L11 24L12 34" fill={accent} />
      <circle cx="32" cy="27" r="3.3" fill={ink} stroke="none" /><circle cx="49" cy="30" r="1.8" fill={ink} stroke="none" />
      <path d="M29 37H54Q51 47 41 45Q31 44 29 37Z" fill={ink} />
      <path d="M34 38L37 42L40 38M44 38L47 42L50 38" fill="#fff5e4" stroke="none" /><circle cx="23" cy="37" r="3" fill={accent} stroke="none" />
      <path d="M24 51V66" fill="none" />
    </>}
    {design === 1 && <>
      <path d="M15 66Q18 54 29 53V31Q14 32 14 22Q14 12 28 12Q41 12 43 21Q45 29 36 31V53Q51 54 54 66" fill={skin} />
      <path d="M28 12L30 7L35 14M34 32L40 37L35 41M35 43L41 48L35 51" fill={accent} />
      <circle cx="24" cy="21" r="3" fill={ink} stroke="none" /><circle cx="37" cy="21" r="1.5" fill={ink} stroke="none" /><path d="M20 27Q26 31 30 27" fill="none" />
      <path d="M23 65Q27 56 33 56Q39 56 43 65" fill={accent} />
    </>}
    {design === 2 && <>
      <path d="M10 31L7 21L15 18L17 10L25 14L32 7L39 14L47 10L49 18L57 21L54 31L57 40L47 45H17L7 40Z" fill={accent} />
      <path d="M15 66V56Q15 47 26 46H38Q49 47 49 56V66" fill={skin} /><rect x="17" y="20" width="30" height="31" rx="14" fill={skin} />
      <path d="M22 27L18 12L28 22M42 27L46 12L36 22" fill="#fff5e4" />
      <circle cx="24" cy="33" r="3" fill={ink} stroke="none" /><circle cx="40" cy="33" r="3" fill={ink} stroke="none" />
      <ellipse cx="32" cy="42" rx="11" ry="7" fill={skin} /><path d="M29 40L32 32L35 40" fill="#fff5e4" /><path d="M26 45Q32 49 38 45" fill="none" />
    </>}
    {design === 3 && <>
      <path d="M15 45L7 36L16 31L12 21L24 21L28 10L36 18L45 12L49 26" fill={accent} />
      <path d="M10 66V51Q10 37 25 34Q25 24 37 23Q48 23 53 34V45Q47 52 35 50L40 66" fill={skin} />
      <circle cx="38" cy="33" r="3" fill={ink} stroke="none" /><circle cx="48" cy="36" r="1.5" fill={ink} stroke="none" /><path d="M36 43Q43 48 49 42" fill="none" />
      <path d="M14 54L19 58M22 49L27 53" /><path d="M23 65V58M33 65V59" />
    </>}
    {design === 4 && <>
      <path d="M18 28L13 17L24 20L26 8L34 18L40 10L43 23" fill={accent} />
      <path d="M12 66Q12 49 23 46Q13 33 22 25Q32 16 46 24L56 31L51 43Q44 49 34 45L40 66" fill={skin} />
      <path d="M29 30L36 27" /><circle cx="34" cy="31" r="3" fill={ink} stroke="none" /><circle cx="49" cy="31" r="1.4" fill={ink} stroke="none" />
      <path d="M33 38L52 35Q51 46 39 44Z" fill={ink} /><path d="M38 38L41 42L44 37M47 36L49 40L51 36" fill="#fff5e4" stroke="none" />
      <path d="M16 57L21 51M20 62L27 54" />
    </>}
    {design === 5 && <>
      <path d="M24 46L5 52L12 34L27 38M40 46L59 52L52 34L37 38" fill={accent} />
      <path d="M19 66L24 41Q16 36 21 27L16 11L30 22Q43 21 46 33L56 41L43 46L46 66" fill={skin} />
      <path d="M35 36L56 41L40 44" fill="#ffe28a" /><circle cx="33" cy="30" r="3.5" fill={ink} stroke="none" /><path d="M27 26L33 24" />
      <path d="M29 50L31 61L35 50" fill={accent} />
    </>}
    {design === 6 && <>
      <path d="M13 66Q10 48 22 45H42Q54 48 51 66" fill={skin} />
      <path d="M14 22L11 14L22 16L27 9L33 14L42 10L45 18L54 20L49 30" fill={accent} />
      <path d="M17 29L7 30L13 37L6 42L17 45M47 29L57 30L51 37L58 42L47 45" fill={accent} />
      <rect x="15" y="20" width="34" height="31" rx="15" fill={skin} /><path d="M18 25L23 21L28 25L33 21L38 25L43 21L46 25" fill="none" />
      <path d="M21 34Q25 29 29 34M35 34Q39 29 43 34" fill="none" /><path d="M26 43Q32 48 38 43" fill="none" /><circle cx="19" cy="40" r="2.5" fill={accent} stroke="none" /><circle cx="45" cy="40" r="2.5" fill={accent} stroke="none" />
      <path d="M25 58H39M28 63H36" />
    </>}
    {design === 7 && <>
      <path d="M22 25Q17 10 35 7Q51 5 54 14Q42 11 38 24" fill={accent} />
      <path d="M12 66Q12 49 24 46Q15 35 22 26Q28 19 42 24Q54 28 53 39Q53 49 38 48L42 66" fill={skin} />
      <circle cx="32" cy="32" r="3" fill={ink} stroke="none" /><circle cx="48" cy="33" r="1.6" fill={ink} stroke="none" /><path d="M32 42Q42 48 48 41" fill="none" />
      <path d="M23 52L27 66M19 56L15 60" /><circle cx="23" cy="39" r="3" fill={accent} stroke="none" />
    </>}
  </Frame>;
}

export function SmileyPortrait({ design, background, accent }: Colors) {
  return <Frame background={background}>
    <circle cx="32" cy="33" r="22" fill="#ffe28a" />
    <path d="M18 23Q21 17 27 16" stroke="#fff5cf" strokeWidth="3" fill="none" />
    {design === 0 && <><ellipse cx="24" cy="28" rx="2.8" ry="4" fill={ink} stroke="none" /><ellipse cx="40" cy="28" rx="2.8" ry="4" fill={ink} stroke="none" /><path d="M21 37H43Q40 49 32 49Q24 49 21 37Z" fill={ink} /><path d="M24 38H40V41H24Z" fill="#fff5e4" stroke="none" /></>}
    {design === 1 && <><path d="M20 28Q24 23 28 28" fill="none" strokeWidth="3" /><ellipse cx="40" cy="28" rx="3" ry="4" fill={ink} stroke="none" /><path d="M23 38Q32 47 42 36" fill="none" /><path d="M30 41Q38 39 39 45Q37 52 32 49Z" fill="#f07c93" /></>}
    {design === 2 && <><path d="M13 25H51" strokeWidth="3" /><path d="M16 25H29V32Q28 36 24 36H21Q17 35 16 31ZM35 25H48L47 31Q46 35 42 36H39Q36 36 35 32Z" fill={ink} /><path d="M29 28H35M19 27L23 27M38 27L42 27" stroke={accent} /><path d="M25 43Q32 48 40 41" fill="none" /></>}
    {design === 3 && <><path d="M18 24C18 18 25 18 26 23C28 18 35 20 32 26L25 33Z" fill="#ef7084" /><path d="M35 24C35 18 42 18 43 23C45 18 52 20 49 26L42 33Z" fill="#ef7084" /><path d="M25 39Q32 51 41 38" fill={ink} /><path d="M29 44Q33 42 37 45" stroke="#ef7084" strokeWidth="3" /></>}
    {design === 4 && <><circle cx="24" cy="26" r="5" fill="#fff5e4" /><circle cx="41" cy="30" r="6" fill="#fff5e4" /><circle cx="25" cy="27" r="2" fill={ink} stroke="none" /><circle cx="40" cy="32" r="2.5" fill={ink} stroke="none" /><path d="M20 38L43 42Q35 53 25 47Z" fill={ink} /><path d="M24 39L27 44L30 40M34 41L37 46L40 42" fill="#fff5e4" stroke="none" /></>}
    {design === 5 && <><path d="M19 29Q24 20 29 29M35 29Q40 20 45 29" fill="none" strokeWidth="3" /><path d="M22 37H42Q39 50 32 50Q25 50 22 37Z" fill={ink} /><path d="M26 45Q32 42 37 46" stroke="#ef7084" strokeWidth="4" /><path d="M15 32Q7 42 14 44Q20 44 15 32Z" fill="#a8e3ed" strokeWidth="1.7" /></>}
    {design === 6 && <><ellipse cx="24" cy="28" rx="3" ry="5" fill={ink} stroke="none" /><ellipse cx="40" cy="28" rx="3" ry="5" fill={ink} stroke="none" /><path d="M19 19Q24 16 28 19M36 19Q40 16 45 19" fill="none" /><ellipse cx="32" cy="42" rx="6" ry="8" fill={ink} /></>}
    {design === 7 && <><path d="M19 23L28 26M36 23L45 19" strokeWidth="3" /><circle cx="24" cy="30" r="3" fill={ink} stroke="none" /><circle cx="40" cy="28" r="3" fill={ink} stroke="none" /><path d="M21 40Q34 48 44 35" fill="none" strokeWidth="3" /><circle cx="18" cy="35" r="2.5" fill="#efa277" stroke="none" /></>}
  </Frame>;
}
