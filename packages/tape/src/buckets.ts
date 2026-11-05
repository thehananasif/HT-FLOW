/** Percentiles used to derive size buckets automatically from recent prints. */
export const DEFAULT_BUCKET_PERCENTILES = [0.5, 0.8, 0.95, 0.99];

/**
 * Size bucket of a print: the number of thresholds it reaches (0 = smallest bucket,
 * thresholds.length = largest). Thresholds must be ascending.
 */
export function sizeBucket(qty: number, thresholds: readonly number[]): number {
  let b = 0;
  for (const t of thresholds) {
    if (qty >= t) b++;
    else break;
  }
  return b;
}

/** Linear-interpolated quantile of an unsorted sample (q in 0..1). NaN for an empty sample. */
export function quantile(sample: ArrayLike<number>, q: number): number {
  const n = sample.length;
  if (!n) return Number.NaN;
  const s = Float64Array.from(sample).sort();
  const pos = Math.min(1, Math.max(0, q)) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

/** Ascending, de-duplicated thresholds at the given percentiles of a size sample. */
export function autoThresholds(
  sizes: ArrayLike<number>,
  percentiles: readonly number[] = DEFAULT_BUCKET_PERCENTILES,
): number[] {
  if (!sizes.length) return [];
  const s = Float64Array.from(sizes).sort();
  const out: number[] = [];
  for (const p of percentiles) {
    const pos = p * (s.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    const v = s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
    if (!out.length || v > out[out.length - 1]!) out.push(v);
  }
  return out;
}

/**
 * Big-print threshold: the user value when > 0, otherwise the auto value (top percentile of the
 * sample, never below 2× the median so that uniform flow does not flag every print).
 */
export function bigPrintThreshold(userValue: number, sizes: ArrayLike<number>, pct = 0.99): number {
  if (userValue > 0) return userValue;
  if (!sizes.length) return Number.POSITIVE_INFINITY;
  return Math.max(quantile(sizes, pct), 2 * quantile(sizes, 0.5));
}

export function isBigPrint(qty: number, threshold: number): boolean {
  return qty >= threshold;
}
