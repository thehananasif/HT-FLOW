/**
 * Streaming math helpers. Every helper computes bar i from inputs [0..i] and its own previous
 * outputs [0..i-1], so recomputing the last bar any number of times gives the same result as a
 * full recompute (the SDK's incremental contract). NaN propagates as "no value yet".
 */

export type Series = ArrayLike<number>;

const nan = Number.NaN;

/** Simple moving average of the last n values; NaN until n finite values exist. */
export function sma(src: Series, i: number, n: number): number {
  if (i < n - 1) return nan;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) {
    const x = src[k]!;
    if (Number.isNaN(x)) return nan;
    s += x;
  }
  return s / n;
}

/** Sum of the last n values (NaN if any is missing). */
export function sum(src: Series, i: number, n: number): number {
  if (i < n - 1) return nan;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) {
    const x = src[k]!;
    if (Number.isNaN(x)) return nan;
    s += x;
  }
  return s;
}

/** Linear weighted MA (weights 1..n, newest heaviest). */
export function wma(src: Series, i: number, n: number): number {
  if (i < n - 1) return nan;
  let s = 0;
  let w = 0;
  for (let k = 0; k < n; k++) {
    const x = src[i - n + 1 + k]!;
    if (Number.isNaN(x)) return nan;
    s += x * (k + 1);
    w += k + 1;
  }
  return s / w;
}

/** Number of consecutive finite values ending at i (capped at cap). */
function finiteRun(src: Series, i: number, cap: number): number {
  let c = 0;
  for (let k = i; k >= 0 && c < cap; k--) {
    if (Number.isNaN(src[k]!)) break;
    c++;
  }
  return c;
}

/**
 * Exponential smoothing with factor alpha, seeded with the SMA of the first n values
 * (TA-Lib convention). `out` holds previous results.
 */
export function smooth(out: Series, src: Series, i: number, n: number, alpha: number): number {
  const x = src[i]!;
  if (Number.isNaN(x)) return nan;
  const prev = i > 0 ? out[i - 1]! : nan;
  if (Number.isNaN(prev)) {
    if (finiteRun(src, i, n) < n) return nan;
    return sma(src, i, n);
  }
  return prev + alpha * (x - prev);
}

/** EMA, alpha = 2 / (n + 1). */
export function ema(out: Series, src: Series, i: number, n: number): number {
  return smooth(out, src, i, n, 2 / (n + 1));
}

/** Wilder's smoothing (SMMA / RMA), alpha = 1 / n. */
export function rma(out: Series, src: Series, i: number, n: number): number {
  return smooth(out, src, i, n, 1 / n);
}

/** Highest value over the last n bars (inclusive). */
export function highest(src: Series, i: number, n: number): number {
  if (i < n - 1) return nan;
  let m = -Infinity;
  for (let k = i - n + 1; k <= i; k++) {
    const x = src[k]!;
    if (Number.isNaN(x)) return nan;
    if (x > m) m = x;
  }
  return m;
}

export function lowest(src: Series, i: number, n: number): number {
  if (i < n - 1) return nan;
  let m = Infinity;
  for (let k = i - n + 1; k <= i; k++) {
    const x = src[k]!;
    if (Number.isNaN(x)) return nan;
    if (x < m) m = x;
  }
  return m;
}

/** Bars since the highest value in the last n bars (0 = current bar); ties → most recent. */
export function highestBarsAgo(src: Series, i: number, n: number): number {
  let m = -Infinity;
  let at = 0;
  for (let k = i - n + 1; k <= i; k++) {
    if (src[k]! >= m) {
      m = src[k]!;
      at = i - k;
    }
  }
  return at;
}

export function lowestBarsAgo(src: Series, i: number, n: number): number {
  let m = Infinity;
  let at = 0;
  for (let k = i - n + 1; k <= i; k++) {
    if (src[k]! <= m) {
      m = src[k]!;
      at = i - k;
    }
  }
  return at;
}

/** Population standard deviation of the last n values. */
export function stdev(src: Series, i: number, n: number): number {
  const m = sma(src, i, n);
  if (Number.isNaN(m)) return nan;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) {
    const d = src[k]! - m;
    s += d * d;
  }
  return Math.sqrt(s / n);
}

/** Mean absolute deviation around the SMA (CCI). */
export function meanDev(src: Series, i: number, n: number): number {
  const m = sma(src, i, n);
  if (Number.isNaN(m)) return nan;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += Math.abs(src[k]! - m);
  return s / n;
}

/** Least-squares line over the last n values: value at the last bar, slope per bar, r². */
export function linreg(
  src: Series,
  i: number,
  n: number,
): { value: number; slope: number; intercept: number; r2: number } {
  if (i < n - 1 || n < 2) return { value: nan, slope: nan, intercept: nan, r2: nan };
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let k = 0; k < n; k++) {
    const y = src[i - n + 1 + k]!;
    if (Number.isNaN(y)) return { value: nan, slope: nan, intercept: nan, r2: nan };
    sx += k;
    sy += y;
    sxy += k * y;
    sxx += k * k;
    syy += y * y;
  }
  const den = n * sxx - sx * sx;
  const slope = (n * sxy - sx * sy) / den;
  const intercept = (sy - slope * sx) / n;
  const vy = n * syy - sy * sy;
  const r = vy > 0 ? (n * sxy - sx * sy) / Math.sqrt(den * vy) : 1;
  return { value: intercept + slope * (n - 1), slope, intercept, r2: r * r };
}

/** True range (uses the previous close; first bar = high − low). */
export function trueRange(h: number, l: number, prevClose: number): number {
  if (Number.isNaN(prevClose)) return h - l;
  return Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose));
}

/** a crossed above b between bars i-1 and i. */
export function crossOver(a: Series, b: Series, i: number): boolean {
  return i > 0 && a[i - 1]! <= b[i - 1]! && a[i]! > b[i]!;
}

export function crossUnder(a: Series, b: Series, i: number): boolean {
  return i > 0 && a[i - 1]! >= b[i - 1]! && a[i]! < b[i]!;
}

export function nz(x: number, d = 0): number {
  return Number.isNaN(x) ? d : x;
}

/** Previous value (NaN when out of range). */
export function prev(src: Series, i: number, k = 1): number {
  return i - k >= 0 ? src[i - k]! : nan;
}
