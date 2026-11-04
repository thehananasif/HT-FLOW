export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** rgba() from a #RRGGBB colour. */
export function rgba(hex: string, a: number): string {
  const h = hex.charAt(0) === '#' ? hex.slice(1) : hex;
  const n = parseInt(h.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** UTC day start — default trading session boundary for 24h markets. */
export function sessionStart(t: number): number {
  return Math.floor(t / 86_400_000) * 86_400_000;
}

/** Smallest "nice" rows-per-price grouping that keeps rows at least minPx tall. */
export function rowTicksFor(tickPx: number, minPx: number): number {
  const steps = [1, 2, 4, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
  for (const s of steps) if (s * tickPx >= minPx) return s;
  return 10000;
}
