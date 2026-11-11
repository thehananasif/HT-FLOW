import { parseColor, toHex, type Rgba } from './colorMath';

export interface GradientStop {
  /** 0-1 */
  pos: number;
  /** #rrggbb[aa] */
  color: string;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function sortStops(stops: GradientStop[]): GradientStop[] {
  return [...stops].sort((a, b) => a.pos - b.pos);
}

export function lerpRgba(a: Rgba, b: Rgba, t: number): Rgba {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
    a: a.a + (b.a - a.a) * t,
  };
}

const rgba = (s: string): Rgba => parseColor(s) ?? { r: 0, g: 0, b: 0, a: 1 };

/** Colour of the gradient at t (0-1), linear in RGBA, clamped outside the first/last stop. */
export function sampleGradient(stops: GradientStop[], t: number): Rgba {
  const s = sortStops(stops);
  if (s.length === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const x = clamp01(t);
  if (x <= s[0]!.pos) return rgba(s[0]!.color);
  const last = s[s.length - 1]!;
  if (x >= last.pos) return rgba(last.color);
  for (let i = 1; i < s.length; i++) {
    const hi = s[i]!;
    const lo = s[i - 1]!;
    if (x <= hi.pos) {
      const span = hi.pos - lo.pos;
      return lerpRgba(rgba(lo.color), rgba(hi.color), span === 0 ? 0 : (x - lo.pos) / span);
    }
  }
  return rgba(last.color);
}

export function gradientCss(stops: GradientStop[], angle = 90): string {
  const s = sortStops(stops);
  if (s.length === 0) return 'transparent';
  if (s.length === 1) return s[0]!.color;
  const parts = s.map((x) => `${x.color} ${Math.round(x.pos * 1000) / 10}%`);
  return `linear-gradient(${angle}deg, ${parts.join(', ')})`;
}

/** Inserts a stop at `pos` coloured by the current gradient there. */
export function addStop(stops: GradientStop[], pos: number): GradientStop[] {
  const p = clamp01(pos);
  return sortStops([...stops, { pos: p, color: toHex(sampleGradient(stops, p)) }]);
}

/** Removes stop `index`, always keeping at least two. */
export function removeStop(stops: GradientStop[], index: number): GradientStop[] {
  if (stops.length <= 2) return stops;
  return stops.filter((_, i) => i !== index);
}

export function updateStop(
  stops: GradientStop[],
  index: number,
  patch: Partial<GradientStop>,
): GradientStop[] {
  return stops.map((s, i) =>
    i === index
      ? { pos: patch.pos === undefined ? s.pos : clamp01(patch.pos), color: patch.color ?? s.color }
      : s,
  );
}

/** Pre-computes `n` evenly spaced RGBA samples (for heatmap lookup tables). */
export function gradientLut(stops: GradientStop[], n = 256): Rgba[] {
  return Array.from({ length: n }, (_, i) => sampleGradient(stops, n === 1 ? 0 : i / (n - 1)));
}
