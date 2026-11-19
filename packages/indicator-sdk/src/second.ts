/**
 * Second-instrument support: aligns another instrument's bars to the host chart's bars and the
 * pure statistics (spread, ratio, rolling correlation, rolling beta) built on the aligned closes.
 */
import type { Bar } from '@htflow/market-data';
import { barAtOrBefore } from './foreign';

/**
 * Writes the real-price close (ticks x auxTick) of the last aux bar opened at or before each host
 * bar into out[from..to). Gaps are forward-filled (the aux bar that was last seen); host bars
 * before the first aux bar get NaN. Both bar arrays must be sorted by time.
 */
export function alignAuxClose(
  host: readonly Bar[],
  aux: readonly Bar[],
  auxTick: number,
  from: number,
  to: number,
  out: Float64Array,
): void {
  if (from >= to) return;
  let j = barAtOrBefore(aux, host[from]!.t);
  for (let i = from; i < to; i++) {
    const t = host[i]!.t;
    while (j + 1 < aux.length && aux[j + 1]!.t <= t) j++;
    out[i] = j < 0 ? Number.NaN : aux[j]!.c * auxTick;
  }
}

/** Simple return x[i] / x[i-1] - 1 (NaN when either value is missing or the previous is 0). */
export function simpleReturn(x: ArrayLike<number>, i: number): number {
  if (i < 1) return Number.NaN;
  const a = x[i - 1]!;
  const b = x[i]!;
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return Number.NaN;
  return b / a - 1;
}

/** Mean of x and y over the window [i-n+1, i], or null when n < 2 or any value is not finite. */
function windowMeans(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  i: number,
  n: number,
): [number, number] | null {
  if (n < 2 || i - n + 1 < 0) return null;
  let sx = 0;
  let sy = 0;
  for (let k = i - n + 1; k <= i; k++) {
    const a = x[k]!;
    const b = y[k]!;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    sx += a;
    sy += b;
  }
  return [sx / n, sy / n];
}

/** Rolling Pearson correlation of x and y over the last n values (NaN when undefined). */
export function pearson(x: ArrayLike<number>, y: ArrayLike<number>, i: number, n: number): number {
  const m = windowMeans(x, y, i, n);
  if (!m) return Number.NaN;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let k = i - n + 1; k <= i; k++) {
    const dx = x[k]! - m[0];
    const dy = y[k]! - m[1];
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (!(sxx > 0) || !(syy > 0)) return Number.NaN;
  return Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy)));
}

/** Rolling beta of y on x over the last n values: cov(x, y) / var(x) (NaN when var(x) = 0). */
export function beta(y: ArrayLike<number>, x: ArrayLike<number>, i: number, n: number): number {
  const m = windowMeans(x, y, i, n);
  if (!m) return Number.NaN;
  let sxy = 0;
  let sxx = 0;
  for (let k = i - n + 1; k <= i; k++) {
    const dx = x[k]! - m[0];
    sxy += dx * (y[k]! - m[1]);
    sxx += dx * dx;
  }
  return sxx > 0 ? sxy / sxx : Number.NaN;
}

/** host - k x aux, in real prices (NaN when either is missing). */
export function spreadOf(host: number, aux: number, k = 1): number {
  return Number.isFinite(host) && Number.isFinite(aux) ? host - k * aux : Number.NaN;
}

/** host / aux in real prices (NaN when aux is 0 or missing). */
export function ratioOf(host: number, aux: number): number {
  return Number.isFinite(host) && Number.isFinite(aux) && aux !== 0 ? host / aux : Number.NaN;
}
