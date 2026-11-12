import type { Bar } from '@htflow/market-data';

/** ZigZag swings and CVD correlation (P12 volume-analysis tools). Pure functions over bars. */

export interface Swing {
  /** Bar index of the pivot. */
  i: number;
  /** Pivot price (ticks): a high for dir 1, a low for dir −1. */
  px: number;
  dir: 1 | -1;
}

/**
 * ZigZag pivots of bars [i0, i1]: a swing is confirmed when price retraces `reversal` ticks from
 * the running extreme. The last (unconfirmed) extreme is included so the final leg is drawn.
 */
export function zigzag(bars: readonly Bar[], i0: number, i1: number, reversal: number): Swing[] {
  const lo = Math.max(0, Math.min(i0, i1));
  const hi = Math.min(bars.length - 1, Math.max(i0, i1));
  const out: Swing[] = [];
  if (hi <= lo || !(reversal > 0)) return out;
  let dir: 0 | 1 | -1 = 0;
  let hiI = lo;
  let hiP = bars[lo]!.h;
  let loI = lo;
  let loP = bars[lo]!.l;
  for (let i = lo + 1; i <= hi; i++) {
    const b = bars[i]!;
    if (dir === 0) {
      if (b.h > hiP) {
        hiP = b.h;
        hiI = i;
      }
      if (b.l < loP) {
        loP = b.l;
        loI = i;
      }
      if (hiP - loP >= reversal && hiI > loI) {
        out.push({ i: loI, px: loP, dir: -1 });
        dir = 1;
      } else if (hiP - loP >= reversal && loI > hiI) {
        out.push({ i: hiI, px: hiP, dir: 1 });
        dir = -1;
      }
      continue;
    }
    if (dir === 1) {
      if (b.h > hiP) {
        hiP = b.h;
        hiI = i;
      } else if (hiP - b.l >= reversal) {
        out.push({ i: hiI, px: hiP, dir: 1 });
        dir = -1;
        loP = b.l;
        loI = i;
      }
    } else if (b.l < loP) {
      loP = b.l;
      loI = i;
    } else if (b.h - loP >= reversal) {
      out.push({ i: loI, px: loP, dir: -1 });
      dir = 1;
      hiP = b.h;
      hiI = i;
    }
  }
  if (dir === 1) out.push({ i: hiI, px: hiP, dir: 1 });
  else if (dir === -1) out.push({ i: loI, px: loP, dir: -1 });
  return out;
}

/** Cumulative delta of bars [i0, i1], starting at 0 before the first bar. */
export function cvdSeries(bars: readonly Bar[], i0: number, i1: number): number[] {
  const lo = Math.max(0, Math.min(i0, i1));
  const hi = Math.min(bars.length - 1, Math.max(i0, i1));
  const out: number[] = [];
  let acc = 0;
  for (let i = lo; i <= hi; i++) {
    acc += bars[i]!.delta;
    out.push(acc);
  }
  return out;
}

/** Pearson correlation of two series; null when undefined (flat series, n < 3). */
export function pearson(a: readonly number[], b: readonly number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i]!;
    sb += b[i]!;
  }
  const ma = sa / n;
  const mb = sb / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    cov += x * y;
    va += x * x;
    vb += y * y;
  }
  if (!(va > 0) || !(vb > 0)) return null;
  return cov / Math.sqrt(va * vb);
}

export interface CvdCorrelation {
  corr: number | null;
  cvd: number[];
  /** Price change (ticks) / CVD change over the range. */
  priceChange: number;
  cvdChange: number;
  /** Price and CVD move in opposite directions over the range. */
  divergence: 'bullish' | 'bearish' | 'none';
}

/** Correlation between close price and cumulative delta over bars [i0, i1] plus divergence. */
export function cvdCorrelation(bars: readonly Bar[], i0: number, i1: number): CvdCorrelation {
  const lo = Math.max(0, Math.min(i0, i1));
  const hi = Math.min(bars.length - 1, Math.max(i0, i1));
  const cvd = cvdSeries(bars, lo, hi);
  const closes: number[] = [];
  for (let i = lo; i <= hi; i++) closes.push(bars[i]!.c);
  const priceChange = closes.length ? closes[closes.length - 1]! - closes[0]! : 0;
  const cvdChange = cvd.length ? cvd[cvd.length - 1]! - (cvd[0] ?? 0) : 0;
  let divergence: CvdCorrelation['divergence'] = 'none';
  if (priceChange < 0 && cvdChange > 0) divergence = 'bullish';
  else if (priceChange > 0 && cvdChange < 0) divergence = 'bearish';
  return { corr: pearson(closes, cvd), cvd, priceChange, cvdChange, divergence };
}
