/** Colour conversion helpers (pure, no DOM). Channels r/g/b are 0-255, a is 0-1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}
export interface Hsva {
  /** 0-360 */
  h: number;
  /** 0-1 */
  s: number;
  /** 0-1 */
  v: number;
  a: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const byte = (n: number) => clamp(Math.round(n), 0, 255);

/** Parses #rgb, #rgba, #rrggbb, #rrggbbaa, rgb(r,g,b) and rgba(r,g,b,a). Returns null if invalid. */
export function parseColor(input: string): Rgba | null {
  const s = input.trim().toLowerCase();
  const hex = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (hex) {
    let h = hex[1]!;
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  const fn = /^rgba?\(\s*([^)]*)\)$/.exec(s);
  if (fn) {
    const parts = fn[1]!.split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3 || parts.length > 4) return null;
    const ch = parts
      .slice(0, 3)
      .map((p) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : Number(p)));
    if (ch.some((c) => !Number.isFinite(c))) return null;
    let a = 1;
    if (parts[3] !== undefined) {
      a = parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : Number(parts[3]);
      if (!Number.isFinite(a)) return null;
    }
    return { r: byte(ch[0]!), g: byte(ch[1]!), b: byte(ch[2]!), a: clamp(a, 0, 1) };
  }
  return null;
}

const h2 = (n: number) => byte(n).toString(16).padStart(2, '0');

/** `#rrggbb`, or `#rrggbbaa` when alpha < 1 (or `forceAlpha`). */
export function toHex(c: Rgba, forceAlpha = false): string {
  const base = `#${h2(c.r)}${h2(c.g)}${h2(c.b)}`;
  return c.a < 1 || forceAlpha ? base + h2(clamp(c.a, 0, 1) * 255) : base;
}

export function toRgbString(c: Rgba): string {
  const a = Math.round(clamp(c.a, 0, 1) * 1000) / 1000;
  const rgb = `${byte(c.r)}, ${byte(c.g)}, ${byte(c.b)}`;
  return a < 1 ? `rgba(${rgb}, ${a})` : `rgb(${rgb})`;
}

export function rgbToHsv(c: Rgba): Hsva {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max, a: c.a };
}

export function hsvToRgb(c: Hsva): Rgba {
  const h = ((c.h % 360) + 360) % 360;
  const k = (n: number) => (n + h / 60) % 6;
  const f = (n: number) => c.v - c.v * c.s * Math.max(0, Math.min(k(n), 4 - k(n), 1));
  return { r: byte(f(5) * 255), g: byte(f(3) * 255), b: byte(f(1) * 255), a: c.a };
}

/** Normalises any accepted colour string to `#rrggbb[aa]`; falls back when unparsable. */
export function normalizeColor(input: string, fallback = '#000000'): string {
  const c = parseColor(input);
  return c ? toHex(c) : fallback;
}

export function withAlpha(hex: string, a: number): string {
  const c = parseColor(hex);
  return c ? toHex({ ...c, a: clamp(a, 0, 1) }) : hex;
}

/** Pushes `color` to the front of a most-recent list (dedupe, case-insensitive, capped). */
export function pushRecent(list: string[], color: string, max = 12): string[] {
  const n = normalizeColor(color, '').toLowerCase();
  if (!n) return list;
  return [n, ...list.filter((c) => c.toLowerCase() !== n)].slice(0, max);
}
