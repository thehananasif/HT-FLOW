/**
 * Technical-analysis helpers of the HT Strategy API (`ta.*`). Pure functions on plain number
 * arrays (oldest first); each returns the value at the last element (NaN when there is not enough
 * data) unless its name ends in `Series`.
 */

const NaN_ = Number.NaN;
const nums = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number) : []);
const len = (n: unknown) => (typeof n === 'number' && n >= 1 ? Math.floor(n) : 1);

function smaSeries(values: unknown, length: unknown): number[] {
  const v = nums(values);
  const n = len(length);
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += v[i]!;
    if (i >= n) sum -= v[i - n]!;
    out.push(i >= n - 1 ? sum / n : NaN_);
  }
  return out;
}

function emaSeries(values: unknown, length: unknown): number[] {
  const v = nums(values);
  const n = len(length);
  const k = 2 / (n + 1);
  const out: number[] = [];
  let e = NaN_;
  for (let i = 0; i < v.length; i++) {
    if (i === n - 1) {
      let s = 0;
      for (let j = 0; j < n; j++) s += v[j]!;
      e = s / n;
    } else if (i >= n) e = v[i]! * k + e * (1 - k);
    out.push(i >= n - 1 ? e : NaN_);
  }
  return out;
}

const last = (a: number[]) => (a.length ? a[a.length - 1]! : NaN_);

function window(values: unknown, length: unknown): number[] {
  const v = nums(values);
  const n = len(length);
  return v.length >= n ? v.slice(v.length - n) : [];
}

export const ta = Object.freeze({
  sma: (values: unknown, length: unknown) => last(smaSeries(values, length)),
  ema: (values: unknown, length: unknown) => last(emaSeries(values, length)),
  smaSeries,
  emaSeries,
  highest: (values: unknown, length: unknown) => {
    const w = window(values, length);
    return w.length ? Math.max(...w) : NaN_;
  },
  lowest: (values: unknown, length: unknown) => {
    const w = window(values, length);
    return w.length ? Math.min(...w) : NaN_;
  },
  stdev: (values: unknown, length: unknown) => {
    const w = window(values, length);
    if (!w.length) return NaN_;
    const m = w.reduce((a, b) => a + b, 0) / w.length;
    return Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / w.length);
  },
  rsi: (values: unknown, length: unknown) => {
    const v = nums(values);
    const n = len(length);
    if (v.length <= n) return NaN_;
    let up = 0;
    let dn = 0;
    for (let i = 1; i <= n; i++) {
      const d = v[i]! - v[i - 1]!;
      if (d > 0) up += d;
      else dn -= d;
    }
    up /= n;
    dn /= n;
    for (let i = n + 1; i < v.length; i++) {
      const d = v[i]! - v[i - 1]!;
      up = (up * (n - 1) + Math.max(0, d)) / n;
      dn = (dn * (n - 1) + Math.max(0, -d)) / n;
    }
    return dn === 0 ? 100 : 100 - 100 / (1 + up / dn);
  },
  /** Average true range of bar objects ({ high, low, close }). */
  atr: (bars: unknown, length: unknown) => {
    const b = (Array.isArray(bars) ? bars : []) as { high: number; low: number; close: number }[];
    const n = len(length);
    if (b.length <= n) return NaN_;
    const tr: number[] = [];
    for (let i = 1; i < b.length; i++)
      tr.push(
        Math.max(
          b[i]!.high - b[i]!.low,
          Math.abs(b[i]!.high - b[i - 1]!.close),
          Math.abs(b[i]!.low - b[i - 1]!.close),
        ),
      );
    return last(smaSeries(tr, n));
  },
  /** Volume-weighted average price of bar objects ({ high, low, close, volume }). */
  vwap: (bars: unknown) => {
    const b = (Array.isArray(bars) ? bars : []) as {
      high: number;
      low: number;
      close: number;
      volume: number;
    }[];
    let pv = 0;
    let v = 0;
    for (const x of b) {
      pv += ((x.high + x.low + x.close) / 3) * x.volume;
      v += x.volume;
    }
    return v > 0 ? pv / v : NaN_;
  },
  /** `a` crossed above `b` on the last element (arrays or [prev, now] pairs). */
  crossOver: (a: unknown, b: unknown) => {
    const x = nums(a).slice(-2);
    const y = nums(b).slice(-2);
    return x.length === 2 && y.length === 2 && x[0]! <= y[0]! && x[1]! > y[1]!;
  },
  crossUnder: (a: unknown, b: unknown) => {
    const x = nums(a).slice(-2);
    const y = nums(b).slice(-2);
    return x.length === 2 && y.length === 2 && x[0]! >= y[0]! && x[1]! < y[1]!;
  },
});
