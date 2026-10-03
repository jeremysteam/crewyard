// Keep this mapping stable: an agent's ID is its visual identity across every thread.
export const agentDesignNames = [
  'Orbit', 'Scout', 'Radar', 'Luna', 'Pip', 'Widget', 'Beacon', 'Clover', 'Halo',
  'Rex', 'Bronto', 'Triceratops', 'Stego', 'Raptor', 'Ptero', 'Anky', 'Para',
  'Happy', 'Wink', 'Cool', 'Love', 'Goofy', 'Laugh', 'Wow', 'Cheeky',
] as const;

function hashIdentity(value: string, salt: string) {
  let hash = 2166136261;
  for (const character of `${salt}:${value}`) {
    hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619);
  }
  return hash >>> 0;
}

export function agentAppearance(identity: string) {
  const color = hashIdentity(identity, 'color');
  const hue = color % 360;
  return {
    design: hashIdentity(identity, 'design') % agentDesignNames.length,
    background: `hsl(${hue} ${58 + (color >>> 9) % 19}% ${48 + (color >>> 17) % 12}%)`,
    accent: `hsl(${(hue + 28) % 360} 88% 79%)`,
  };
}

export const managerExpressions = ['Smug', 'Wink', 'Unimpressed', 'Laugh'] as const;
export function managerAppearance(identity: string) {
  return { ...agentAppearance(identity), expression: hashIdentity(identity, 'manager-expression') % managerExpressions.length };
}
