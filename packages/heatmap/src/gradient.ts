export interface GradientStop {
  at: number;
  color: string;
}

/**
 * Stop in the UI-kit GradientEditor format (`{ pos, color }`), so the editor's value can be fed
 * straight into {@link lutFromStops}.
 */
export interface HeatStop {
  /** 0..1 */
  pos: number;
  /** #rrggbb or #rrggbbaa */
  color: string;
}

/** Gradient presets for the heat map (P11 quick settings). */
export const GRADIENTS: Record<string, GradientStop[]> = {
  /** Blue → White → Yellow → Red: the spec default ("thermal"). */
  thermal: [
    { at: 0, color: '#0B1A33' },
    { at: 0.25, color: '#1E5AA8' },
    { at: 0.45, color: '#4FA3F7' },
    { at: 0.6, color: '#FFFFFF' },
    { at: 0.72, color: '#F5D547' },
    { at: 0.85, color: '#F28C28' },
    { at: 1, color: '#E0302E' },
  ],
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
  'blue-red': [
    { at: 0, color: '#060B1E' },
    { at: 0.3, color: '#1C3F9E' },
    { at: 0.55, color: '#6A3FA0' },
    { at: 0.8, color: '#C8323C' },
    { at: 1, color: '#FF5A3C' },
  ],
  viridis: [
    { at: 0, color: '#120A1E' },
    { at: 0.25, color: '#3B528B' },
    { at: 0.5, color: '#21918C' },
    { at: 0.75, color: '#5EC962' },
    { at: 1, color: '#FDE725' },
  ],
};

export const GRADIENT_LABELS: Record<string, string> = {
  thermal: 'Thermal (blue → white → yellow → red)',
  classic: 'Classic',
  ruby: 'Ruby',
  mono: 'Monochrome',
  ocean: 'Ocean',
  'blue-red': 'Blue to red',
  viridis: 'Viridis',
};

export function presetStops(name: string): HeatStop[] {
  return (GRADIENTS[name] ?? GRADIENTS.thermal!).map((s) => ({ pos: s.at, color: s.color }));
}

/** Tone curve applied to the 0..1 heat value before colour lookup. */
export interface ToneOptions {
  /** 0..100, 100 = unchanged. Scales the RGB output. */
  brightness?: number;
  /** 0..100, 50 = unchanged; higher stretches the middle of the ramp (S-curve). */
  contrast?: number;
  /** 0.2..5, 1 = unchanged; < 1 lifts small values, > 1 darkens them. */
  gamma?: number;
  /** 0..100 opacity of the coloured cells (index 0 stays opaque background). */
  opacity?: number;
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Maps t (0..1) through the contrast S-curve and gamma. Pure; tested. */
export function applyTone(t: number, contrast = 50, gamma = 1): number {
  let x = clamp01(t);
  if (gamma !== 1 && gamma > 0) x = Math.pow(x, gamma);
  if (contrast !== 50) {
    // k > 1 steepens, k < 1 flattens around the mid point.
    const k = Math.pow(4, (contrast - 50) / 50);
    const a = Math.pow(x, k);
    const b = Math.pow(1 - x, k);
    x = a + b === 0 ? x : a / (a + b);
  }
  return clamp01(x);
}

function parseHex(color: string): [number, number, number, number] {
  const s = color.trim().replace('#', '');
  const full =
    s.length === 3 || s.length === 4
      ? s
          .split('')
          .map((c) => c + c)
          .join('')
      : s;
  const n = parseInt(full.slice(0, 6), 16);
  const a = full.length >= 8 ? parseInt(full.slice(6, 8), 16) : 255;
  if (!Number.isFinite(n)) return [0, 0, 0, 255];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, Number.isFinite(a) ? a : 255];
}

/**
 * 256-entry RGBA lookup table from editor stops, with brightness / contrast / gamma / opacity
 * baked in so the per-pixel cost stays one table read.
 */
export function lutFromStops(
  stops: readonly HeatStop[],
  tone: ToneOptions = {},
): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 4);
  const sorted = [...stops].sort((a, b) => a.pos - b.pos);
  if (!sorted.length) return lut;
  const parsed = sorted.map((s) => ({ at: clamp01(s.pos), c: parseHex(s.color) }));
  const b = (tone.brightness ?? 100) / 100;
  const op = (tone.opacity ?? 100) / 100;
  for (let i = 0; i < 256; i++) {
    const t = applyTone(i / 255, tone.contrast ?? 50, tone.gamma ?? 1);
    let c: [number, number, number, number];
    if (t <= parsed[0]!.at) c = parsed[0]!.c;
    else if (t >= parsed[parsed.length - 1]!.at) c = parsed[parsed.length - 1]!.c;
    else {
      let k = 0;
      while (k < parsed.length - 2 && t > parsed[k + 1]!.at) k++;
      const a = parsed[k]!;
      const z = parsed[k + 1]!;
      const f = z.at === a.at ? 0 : (t - a.at) / (z.at - a.at);
      c = [0, 1, 2, 3].map((j) => a.c[j]! + (z.c[j]! - a.c[j]!) * f) as [
        number,
        number,
        number,
        number,
      ];
    }
    lut[i * 4] = c[0] * b;
    lut[i * 4 + 1] = c[1] * b;
    lut[i * 4 + 2] = c[2] * b;
    lut[i * 4 + 3] = i === 0 ? 255 : c[3] * op;
  }
  return lut;
}

/** 256-entry RGBA lookup table (legacy preset form). */
export function buildLut(stops: GradientStop[], brightness = 100): Uint8ClampedArray {
  return lutFromStops(
    stops.map((s) => ({ pos: s.at, color: s.color })),
    { brightness },
  );
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
  return Math.max(1, Math.round(t * 255));
}

/** CSS rgba() of a #hex colour. */
export function rgba(hex: string, a: number): string {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/** Packs #rrggbb into a little-endian RGBA Uint32 (as ImageData's Uint32 view reads it). */
export function packColor(hex: string, alpha = 255): number {
  const buf = new Uint8ClampedArray(4);
  const [r, g, b] = parseHex(hex);
  buf[0] = r;
  buf[1] = g;
  buf[2] = b;
  buf[3] = alpha;
  return new Uint32Array(buf.buffer)[0]!;
}
