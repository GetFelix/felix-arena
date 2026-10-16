/** Every colour in the game. Nothing outside this module writes a colour literal; see docs/art.md. */
export const palette = {
  void: '#0a0f15',
  floor: '#2a3646',
  floorAlt: '#2e3b4d',
  seam: '#111821',
  wall: '#2b3544',
  hull: '#d3dae3',
  hullDark: '#6c7889',
  trim: '#1b212a',
  rock: 'hsl(22, 16%, 36%)',
  accent: 'hsl(192, 90%, 42%)',
  accentGlow: 'hsl(190, 95%, 58%)',
  prop: 'hsl(208, 16%, 46%)',
  coral: 'hsl(12, 90%, 60%)',
  violet: 'hsl(262, 75%, 64%)',
} as const;
