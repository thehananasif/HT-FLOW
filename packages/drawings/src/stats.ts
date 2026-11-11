import {
  buildProfile,
  finishProfile,
  type Bar,
  type Instrument,
  type ProfileLevel,
  type VolumeProfile,
} from '@htflow/market-data';

/** Currency value of one tick for one contract (linear crypto: tickSize in quote currency). */
export function tickValue(inst: Pick<Instrument, 'tickSize' | 'tickValue'>): number {
  return inst.tickValue > 0 ? inst.tickValue : inst.tickSize;
}

/** Bars whose open time lies in [tFrom, tTo] (inclusive index range; i1 < i0 when empty). */
export function barRange(
  bars: readonly Bar[],
  tFrom: number,
  tTo: number,
): { i0: number; i1: number } {
  const lo = Math.min(tFrom, tTo);
  const hi = Math.max(tFrom, tTo);
  // first bar with t >= lo — but include the bar that contains lo.
  let a = 0;
  let b = bars.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (bars[m]!.t <= lo) a = m + 1;
    else b = m;
  }
  const i0 = Math.max(0, a - 1);
  a = 0;
  b = bars.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (bars[m]!.t <= hi) a = m + 1;
    else b = m;
  }
  const i1 = a - 1;
  // A range entirely after the last trade of the last bar contains nothing.
  const last = bars[bars.length - 1];
  if (last && i0 === bars.length - 1 && lo > last.tEnd) return { i0: 1, i1: 0 };
  return { i0, i1 };
}

export interface RangeStats {
  bars: number;
  ms: number;
  ticks: number;
  points: number;
  pct: number;
  /** Currency per contract. */
  value: number;
  volume: number;
  delta: number;
}

/**
 * Ruler / Measure: bars, time, ticks, points, %, $ per contract and the volume & delta traded
 * inside the time × price box (from bar clusters).
 */
export function rangeStats(
  inst: Pick<Instrument, 'tickSize' | 'tickValue'>,
  a: { t: number; px: number; slot: number },
  b: { t: number; px: number; slot: number },
  bars: readonly Bar[] | null,
): RangeStats {
  const ticks = Math.round(b.px) - Math.round(a.px);
  const basePrice = Math.round(a.px) * inst.tickSize;
  let volume = 0;
  let delta = 0;
  if (bars && bars.length) {
    const { i0, i1 } = barRange(bars, a.t, b.t);
    const lo = Math.min(Math.round(a.px), Math.round(b.px));
    const hi = Math.max(Math.round(a.px), Math.round(b.px));
    for (let i = i0; i <= i1; i++) {
      for (const [px, c] of bars[i]!.clusters) {
        if (px < lo || px > hi) continue;
        volume += c.bid + c.ask;
        delta += c.ask - c.bid;
      }
    }
  }
  return {
    bars: Math.round(Math.abs(b.slot - a.slot)),
    ms: b.t - a.t,
    ticks,
    points: ticks * inst.tickSize,
    pct: basePrice !== 0 ? ((ticks * inst.tickSize) / basePrice) * 100 : 0,
    value: ticks * tickValue(inst),
    volume,
    delta,
  };
}

export interface PositionStats {
  side: 'long' | 'short';
  entry: number;
  tp: number;
  sl: number;
  tpTicks: number;
  slTicks: number;
  rr: number;
  qty: number;
  /** Currency at target / at stop for qty. */
  profit: number;
  loss: number;
}

/** Long/Short Position tool: R:R, P&L in ticks and currency; qty from risk $ when riskUsd > 0. */
export function positionStats(
  inst: Pick<Instrument, 'tickSize' | 'tickValue'>,
  side: 'long' | 'short',
  entry: number,
  tp: number,
  sl: number,
  qty: number,
  riskUsd = 0,
): PositionStats {
  const dir = side === 'long' ? 1 : -1;
  const tpTicks = Math.round((tp - entry) * dir);
  const slTicks = Math.round((entry - sl) * dir);
  const tv = tickValue(inst);
  let q = qty;
  if (riskUsd > 0 && slTicks > 0 && tv > 0) q = Math.max(0, Math.floor(riskUsd / (slTicks * tv)));
  return {
    side,
    entry,
    tp,
    sl,
    tpTicks,
    slTicks,
    rr: slTicks > 0 ? tpTicks / slTicks : 0,
    qty: q,
    profit: tpTicks * tv * q,
    loss: slTicks * tv * q,
  };
}

/** Volume profile of bars [i0, i1] optionally limited to prices [lo, hi]. */
export function rangeProfile(
  bars: readonly Bar[],
  i0: number,
  i1: number,
  vaPct = 0.7,
  lo = -Infinity,
  hi = Infinity,
): VolumeProfile {
  if (lo === -Infinity && hi === Infinity) return buildProfile(bars, i0, i1, vaPct);
  const levels = new Map<number, ProfileLevel>();
  let total = 0;
  let buy = 0;
  let sell = 0;
  for (let i = Math.max(0, i0); i <= Math.min(bars.length - 1, i1); i++) {
    for (const [px, c] of bars[i]!.clusters) {
      if (px < lo || px > hi) continue;
      let l = levels.get(px);
      if (!l) levels.set(px, (l = { vol: 0, buy: 0, sell: 0 }));
      l.vol += c.bid + c.ask;
      l.buy += c.ask;
      l.sell += c.bid;
      total += c.bid + c.ask;
      buy += c.ask;
      sell += c.bid;
    }
  }
  return finishProfile(levels, total, buy, sell, vaPct);
}

/**
 * TPO profile: for each price, the number of distinct periods (default 30 min) in which it traded.
 * Returned in the VolumeProfile shape (vol = TPO count) so POC / value area work the same way.
 */
export function tpoProfile(
  bars: readonly Bar[],
  i0: number,
  i1: number,
  periodMs = 1_800_000,
  vaPct = 0.7,
  lo = -Infinity,
  hi = Infinity,
): VolumeProfile {
  const seen = new Map<number, Set<number>>();
  for (let i = Math.max(0, i0); i <= Math.min(bars.length - 1, i1); i++) {
    const b = bars[i]!;
    const period = Math.floor(b.t / periodMs);
    for (const px of b.clusters.keys()) {
      if (px < lo || px > hi) continue;
      let s = seen.get(px);
      if (!s) seen.set(px, (s = new Set()));
      s.add(period);
    }
  }
  const levels = new Map<number, ProfileLevel>();
  let total = 0;
  for (const [px, s] of seen) {
    levels.set(px, { vol: s.size, buy: 0, sell: 0 });
    total += s.size;
  }
  return finishProfile(levels, total, 0, 0, vaPct);
}

export interface VwapPoint {
  i: number;
  vwap: number;
  sd: number;
}

/** Anchored VWAP from bar i0 to the last bar, using exact cluster prices; with σ. */
export function anchoredVwap(bars: readonly Bar[], i0: number): VwapPoint[] {
  const out: VwapPoint[] = [];
  let pv = 0;
  let p2v = 0;
  let v = 0;
  for (let i = Math.max(0, i0); i < bars.length; i++) {
    for (const [px, c] of bars[i]!.clusters) {
      const q = c.bid + c.ask;
      pv += px * q;
      p2v += px * px * q;
      v += q;
    }
    if (v > 0) {
      const vwap = pv / v;
      out.push({ i, vwap, sd: Math.sqrt(Math.max(0, p2v / v - vwap * vwap)) });
    }
  }
  return out;
}

/** Developing (dynamic) POC from bar i0: POC of the cumulative profile after each bar. */
export function dynamicPoc(bars: readonly Bar[], i0: number): { i: number; poc: number }[] {
  const vol = new Map<number, number>();
  const out: { i: number; poc: number }[] = [];
  let poc = Number.NaN;
  let max = 0;
  for (let i = Math.max(0, i0); i < bars.length; i++) {
    for (const [px, c] of bars[i]!.clusters) {
      const v = (vol.get(px) ?? 0) + c.bid + c.ask;
      vol.set(px, v);
      if (v > max || (v === max && px < poc)) {
        max = v;
        poc = px;
      }
    }
    if (Number.isFinite(poc)) out.push({ i, poc });
  }
  return out;
}

/** Least-squares line through closes of bars [i0, i1]: close ≈ a + b·(i − i0); sd of residuals. */
export function regression(
  bars: readonly Bar[],
  i0: number,
  i1: number,
): { a: number; b: number; sd: number } | null {
  const lo = Math.max(0, Math.min(i0, i1));
  const hi = Math.min(bars.length - 1, Math.max(i0, i1));
  const n = hi - lo + 1;
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  for (let i = lo; i <= hi; i++) {
    const x = i - lo;
    const y = bars[i]!.c;
    sx += x;
    sy += y;
    sxy += x * y;
    sxx += x * x;
  }
  const den = n * sxx - sx * sx;
  const b = den ? (n * sxy - sx * sy) / den : 0;
  const a = (sy - b * sx) / n;
  let ss = 0;
  for (let i = lo; i <= hi; i++) {
    const r = bars[i]!.c - (a + b * (i - lo));
    ss += r * r;
  }
  return { a, b, sd: Math.sqrt(ss / n) };
}

/** Throttled per-drawing cache for heavy computations on live data. */
const cache = new Map<string, { key: string; version: number; at: number; value: unknown }>();

export function cached<T>(
  id: string,
  key: string,
  version: number,
  fn: () => T,
  maxAgeMs = 400,
): T {
  const now = Date.now();
  const e = cache.get(id);
  if (e && e.key === key && (e.version === version || now - e.at < maxAgeMs)) return e.value as T;
  const value = fn();
  cache.set(id, { key, version, at: now, value });
  if (cache.size > 500) cache.delete(cache.keys().next().value as string);
  return value;
}
