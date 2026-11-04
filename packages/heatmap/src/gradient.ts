export interface GradientStop {
  at: number;
  color: string;
}

/** Gradient presets for the heat map (P11 quick settings). */
export const GRADIENTS: Record<string, GradientStop[]> = {
  classic: [
    { at: 0, color: '#0A1A3A' },
    { at: 0.35, color: '#2F6CB0' },
    { at: 0.6, color: '#FFFFFF' },
    { at: 0.8, color: '#F5C542' },
    { at: 1, color: '#F04A5D' },
  ],
  ruby: [
    { at: 0, color: '#140A0F' },
    { at: 0.12, color: '#2A0F18' },
    { at: 0.45, color: '#5A1626' },
    { at: 0.8, color: '#A01828' },
    { at: 1, color: '#FF1E2E' },
  ],
  mono: [
    { at: 0, color: '#0A0A0A' },
    { at: 1, color: '#FFFFFF' },
  ],
  ocean: [
    { at: 0, color: '#04121A' },
    { at: 0.5, color: '#0E5C7A' },
    { at: 1, color: '#7FF0FF' },
  ],
};

/** 256-entry RGBA lookup table. */
export function buildLut(stops: GradientStop[], brightness = 100): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 4);
  const parsed = stops.map((s) => ({ at: s.at, c: parseInt(s.color.slice(1, 7), 16) }));
  const b = brightness / 100;
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < parsed.length - 2 && t > parsed[k + 1]!.at) k++;
    const a = parsed[k]!;
    const z = parsed[Math.min(k + 1, parsed.length - 1)]!;
    const f = z.at === a.at ? 0 : Math.min(1, Math.max(0, (t - a.at) / (z.at - a.at)));
    const ch = (s: number) => ((a.c >> s) & 255) + (((z.c >> s) & 255) - ((a.c >> s) & 255)) * f;
    lut[i * 4] = ch(16) * b;
    lut[i * 4 + 1] = ch(8) * b;
    lut[i * 4 + 2] = ch(0) * b;
    lut[i * 4 + 3] = 255;
  }
  return lut;
}

/** Value at a percentile (0..1) of a sample (sorted in place). */
export function percentile(sample: Float32Array, p: number): number {
  if (!sample.length) return 0;
  sample.sort();
  return sample[Math.min(sample.length - 1, Math.max(0, Math.floor(p * (sample.length - 1))))]!;
}

export type HeatScale = 'linear' | 'log' | 'sqrt';

/** Maps qty to 0..255 given lower/upper cut-off values. */
export function heatIndex(q: number, lo: number, hi: number, scale: HeatScale): number {
  if (q <= lo) return 0;
  let t = (q - lo) / Math.max(1e-12, hi - lo);
  if (t > 1) t = 1;
  if (scale === 'sqrt') t = Math.sqrt(t);
  else if (scale === 'log') t = Math.log1p(t * 9) / Math.log(10);
  return Math.round(t * 255);
}
