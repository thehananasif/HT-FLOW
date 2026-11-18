/**
 * CSS colour → straight (non-premultiplied) RGBA floats in [0, 1]. Both chart backends take the
 * same parsed colour: Canvas2D turns it back into an `rgba()` string, WebGL2 uploads the floats.
 * Pure and cached (palettes reuse a handful of strings every frame).
 */
export type Rgba = readonly [number, number, number, number];

const BLACK: Rgba = [0, 0, 0, 1];
const NAMED: Record<string, Rgba> = {
  transparent: [0, 0, 0, 0],
  black: BLACK,
  white: [1, 1, 1, 1],
  red: [1, 0, 0, 1],
  green: [0, 128 / 255, 0, 1],
  blue: [0, 0, 1, 1],
};

const cache = new Map<string, Rgba>();

function hexDigit(s: string, i: number): number {
  return parseInt(s.charAt(i) + s.charAt(i), 16);
}

function parseUncached(css: string): Rgba {
  const s = css.trim().toLowerCase();
  if (s.charAt(0) === '#') {
    const h = s.slice(1);
    if (!/^[0-9a-f]+$/.test(h)) return BLACK;
    if (h.length === 3 || h.length === 4) {
      const a = h.length === 4 ? hexDigit(h, 3) / 255 : 1;
      return [hexDigit(h, 0) / 255, hexDigit(h, 1) / 255, hexDigit(h, 2) / 255, a];
    }
    if (h.length === 6 || h.length === 8) {
      const n = parseInt(h.slice(0, 6), 16);
      const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
      return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a];
    }
    return BLACK;
  }
  const m = /^rgba?\(([^)]*)\)$/.exec(s);
  if (m) {
    const parts = m[1]!
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map((p) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p)));
    if (parts.length < 3 || parts.some((p) => !Number.isFinite(p))) return BLACK;
    const raw = m[1]!.split(/[\s,/]+/).filter(Boolean)[3];
    const a = raw === undefined ? 1 : raw.endsWith('%') ? parseFloat(raw) / 100 : parseFloat(raw);
    const c = (x: number) => Math.max(0, Math.min(1, x / 255));
    return [c(parts[0]!), c(parts[1]!), c(parts[2]!), Math.max(0, Math.min(1, a))];
  }
  return NAMED[s] ?? BLACK;
}

/** Parsed colour (cached). Unknown strings resolve to opaque black. */
export function parseColor(css: string): Rgba {
  let c = cache.get(css);
  if (!c) {
    c = parseUncached(css);
    if (cache.size > 4096) cache.clear();
    cache.set(css, c);
  }
  return c;
}

/** `rgba()` string of float components (alpha kept to 4 decimals). */
export function cssOf(r: number, g: number, b: number, a: number): string {
  return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${Math.round(a * 10000) / 10000})`;
}
