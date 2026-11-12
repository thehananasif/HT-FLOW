import type { DepthColumn } from '@htflow/market-data';

/**
 * Normalisation of resting size to the 0..255 heat index (P11: "normalise per column / global").
 *
 * - `global`: one lower / upper cut-off for every column, taken from the visible window or the
 *   whole session (`scope`).
 * - `column`: each column gets its own cut-offs from its own sizes, so thin periods are as
 *   readable as busy ones.
 */
export type NormalizeMode = 'global' | 'column';
export type NormalizeScope = 'visible' | 'session';

export interface Cutoffs {
  lo: number;
  hi: number;
}

/** Percentile (0..1) of the values without mutating them (copy + native typed sort). */
export function percentileOf(values: ArrayLike<number>, p: number): number {
  const n = values.length;
  if (!n) return 0;
  const a = Float32Array.from(values as ArrayLike<number>);
  a.sort();
  const k = Math.min(n - 1, Math.max(0, Math.floor(p * (n - 1))));
  return a[k]!;
}

/** Lower / upper cut-off values from percentages (0..100). Guarantees hi > lo when data exists. */
export function cutoffsOf(values: ArrayLike<number>, lowerPct: number, upperPct: number): Cutoffs {
  if (!values.length) return { lo: 0, hi: 1 };
  const a = Float32Array.from(values as ArrayLike<number>);
  a.sort();
  const at = (p: number) => a[Math.min(a.length - 1, Math.max(0, Math.floor(p * (a.length - 1))))]!;
  const lo = at(Math.min(lowerPct, upperPct) / 100);
  let hi = at(Math.max(lowerPct, upperPct) / 100);
  if (!(hi > lo)) hi = lo + Math.max(1e-9, Math.abs(lo) * 1e-6);
  // Values at the lower cut-off are background; nudge lo just below so the smallest positive
  // size is still drawn when the lower cut-off is 0 %.
  return { lo: lowerPct <= 0 ? Math.min(lo, 0) : lo, hi };
}

const columnCache = new WeakMap<DepthColumn, { key: string; c: Cutoffs }>();

/** Cut-offs of one depth column (cached per column object and percentages). */
export function columnCutoffs(col: DepthColumn, lowerPct: number, upperPct: number): Cutoffs {
  const key = `${lowerPct}:${upperPct}`;
  const hit = columnCache.get(col);
  if (hit && hit.key === key) return hit.c;
  const c = cutoffsOf(col.qtys, lowerPct, upperPct);
  columnCache.set(col, { key, c });
  return c;
}

/**
 * Global cut-offs from a strided sample of columns in [i0, i1] (visible) or the whole array
 * (session), restricted to prices in [bottom, top] when given.
 */
export function globalCutoffs(
  cols: readonly DepthColumn[],
  i0: number,
  i1: number,
  lowerPct: number,
  upperPct: number,
  priceRange: [number, number] | null,
  maxSample = 20000,
): Cutoffs {
  const from = Math.max(0, i0);
  const to = Math.min(cols.length - 1, i1);
  if (to < from) return { lo: 0, hi: 1 };
  const span = to - from + 1;
  const step = Math.max(1, Math.floor(span / 400));
  const sample = new Float32Array(maxSample);
  let n = 0;
  const lo = priceRange ? priceRange[0] : -Infinity;
  const hi = priceRange ? priceRange[1] : Infinity;
  for (let i = from; i <= to && n < maxSample; i += step) {
    const c = cols[i]!;
    const kStep = c.qtys.length > 100 ? 2 : 1;
    for (let k = 0; k < c.qtys.length && n < maxSample; k += kStep) {
      const px = c.pxs[k]!;
      if (px >= lo && px <= hi) sample[n++] = c.qtys[k]!;
    }
  }
  return cutoffsOf(sample.subarray(0, n), lowerPct, upperPct);
}

/** Session-wide cut-offs cached by (array length, first column time) so they update as data grows. */
export class SessionCutoffs {
  private key = '';
  private value: Cutoffs = { lo: 0, hi: 1 };

  get(cols: readonly DepthColumn[], lowerPct: number, upperPct: number): Cutoffs {
    // Recompute every 40 new columns (10 s at 250 ms) — cut-offs move slowly.
    const key = `${cols[0]?.t ?? 0}:${Math.floor(cols.length / 40)}:${lowerPct}:${upperPct}`;
    if (key !== this.key) {
      this.key = key;
      this.value = globalCutoffs(cols, 0, cols.length - 1, lowerPct, upperPct, null, 40000);
    }
    return this.value;
  }
}
