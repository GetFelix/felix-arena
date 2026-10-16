import { CanvasTexture, Color, SRGBColorSpace } from 'three';
import { grey, palette, withAlpha } from './palette';

function canvas(width: number, height = width): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return [c, c.getContext('2d')!];
}

function srgb(c: HTMLCanvasElement): CanvasTexture {
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

function radial(stops: [number, string][], size = 128): CanvasTexture {
  const [c, g] = canvas(size);
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, s] of stops) grd.addColorStop(o, s);
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  return srgb(c);
}

/** A soft white dot, tinted by the material that uses it. */
export function glowTexture(): CanvasTexture {
  return radial([
    [0, withAlpha('white', 1)],
    [0.25, withAlpha('white', 0.55)],
    [1, withAlpha('white', 0)],
  ]);
}

/** A soft dark disc: the contact shadow under a hovering craft. */
export function blobTexture(): CanvasTexture {
  return radial([
    [0, withAlpha('black', 0.55)],
    [0.6, withAlpha('black', 0.25)],
    [1, withAlpha('black', 0)],
  ]);
}

/** A four-point star for muzzle flashes and hits. */
export function flareTexture(): CanvasTexture {
  const s = 128;
  const [c, g] = canvas(s);
  g.translate(s / 2, s / 2);
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 4; i++) {
    g.rotate(Math.PI / 4);
    const grd = g.createLinearGradient(-s / 2, 0, s / 2, 0);
    grd.addColorStop(0, withAlpha('white', 0));
    grd.addColorStop(0.5, withAlpha('white', i % 2 ? 0.5 : 1));
    grd.addColorStop(1, withAlpha('white', 0));
    g.fillStyle = grd;
    g.fillRect(-s / 2, i % 2 ? -2 : -4, s, i % 2 ? 4 : 8);
  }
  return srgb(c);
}

/** The floor's colour, roughness and emissive maps. */
export interface FloorTextures {
  map: CanvasTexture;
  roughnessMap: CanvasTexture;
  emissiveMap: CanvasTexture;
}

/**
 * The floor of an arena `halfX` by `halfZ` metres: 2 m panels with slight value changes, dark seams, and markings
 * that glow (the centre ring, the midline and each team's spawn zone).
 */
export function floorTextures(halfX: number, halfZ: number, anisotropy: number): FloorTextures {
  const ppm = 32;
  const w = halfX * 2 * ppm;
  const h = halfZ * 2 * ppm;
  const [colourC, g] = canvas(w, h);
  const [roughC, r] = canvas(w, h);
  const [emitC, e] = canvas(w, h);
  e.fillStyle = palette.black;
  e.fillRect(0, 0, w, h);
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const panel = 2 * ppm;
  for (let y = 0; y < h; y += panel) {
    for (let x = 0; x < w; x += panel) {
      const alt = ((x + y) / panel) % 2 === 0;
      const base = new Color(alt ? palette.floor : palette.floorAlt).offsetHSL(0, 0, (rnd() - 0.5) * 0.018);
      g.fillStyle = '#' + base.getHexString();
      g.fillRect(x, y, panel, panel);
      r.fillStyle = grey(120 + Math.floor(rnd() * 50));
      r.fillRect(x, y, panel, panel);
    }
  }
  g.strokeStyle = palette.seam;
  g.lineWidth = 2;
  r.strokeStyle = grey(255);
  r.lineWidth = 3;
  const stroke = (x0: number, y0: number, x1: number, y1: number) => {
    for (const ctx of [g, r]) {
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
  };
  for (let x = 0; x <= w; x += panel) stroke(x, 0, x, h);
  for (let y = 0; y <= h; y += panel) stroke(0, y, w, y);

  const cx = w / 2;
  const cy = h / 2;
  for (const ctx of [g, e]) {
    ctx.strokeStyle = ctx === g ? palette.marking : palette.markingGlow;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(cx, cy, 4.2 * ppm, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([ppm * 0.8, ppm * 0.6]);
    ctx.beginPath();
    ctx.moveTo(cx, 0.6 * ppm);
    ctx.lineTo(cx, cy - 4.2 * ppm);
    ctx.moveTo(cx, cy + 4.2 * ppm);
    ctx.lineTo(cx, h - 0.6 * ppm);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  const zone = (x0: number, colour: string) => {
    g.fillStyle = colour;
    g.globalAlpha = 0.06;
    g.fillRect(x0, 4 * ppm, 4 * ppm, h - 8 * ppm);
    g.globalAlpha = 1;
    for (const ctx of [g, e]) {
      ctx.strokeStyle = colour;
      ctx.globalAlpha = ctx === e ? 0.55 : 0.6;
      ctx.lineWidth = 4;
      ctx.strokeRect(x0 + 4, 4 * ppm, 4 * ppm - 8, h - 8 * ppm);
      ctx.globalAlpha = 1;
    }
  };
  zone(0.5 * ppm, palette.coral);
  zone(w - 4.5 * ppm, palette.violet);

  const texture = (c: HTMLCanvasElement, colour: boolean) => {
    const t = colour ? srgb(c) : new CanvasTexture(c);
    t.anisotropy = anisotropy;
    return t;
  };
  return { map: texture(colourC, true), roughnessMap: texture(roughC, false), emissiveMap: texture(emitC, true) };
}
