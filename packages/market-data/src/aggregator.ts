import type { Trade } from './types';

/** Bar types (P07). Each also accepts any custom value. */
export type BarSpec =
  | { kind: 'time'; ms: number }
  | { kind: 'tick'; n: number }
  | { kind: 'volume'; n: number }
  | { kind: 'delta'; n: number }
  | { kind: 'range'; ticks: number };

/** Per-price cluster cell. bid = volume sold into the bid (sell aggressor), ask = volume bought at the ask. */
export interface Cluster {
  bid: number;
  ask: number;
  trades: number;
  /** Largest single print at this price. */
  maxTrade: number;
}

export interface Bar {
  /** Open time (aligned for time bars, first trade time otherwise), epoch ms. */
  t: number;
  /** Time of the last trade in the bar. */
  tEnd: number;
  o: number;
  h: number;
  l: number;
  c: number;
  vol: number;
  buy: number;
  sell: number;
  delta: number;
  maxDelta: number;
  minDelta: number;
  trades: number;
  clusters: Map<number, Cluster>;
  /** Count-based bars (tick/volume/delta/range) close explicitly. */
  closed: boolean;
}

export function specKey(spec: BarSpec): string {
  switch (spec.kind) {
    case 'time':
      return `t${spec.ms}`;
    case 'tick':
      return `k${spec.n}`;
    case 'volume':
      return `v${spec.n}`;
    case 'delta':
      return `d${spec.n}`;
    case 'range':
      return `r${spec.ticks}`;
  }
}

export function specLabel(spec: BarSpec): string {
  switch (spec.kind) {
    case 'time': {
      const s = spec.ms / 1000;
      if (s < 60) return `S${s}`;
      if (s < 3600) return `M${s / 60}`;
      if (s < 86400) return `H${s / 3600}`;
      if (s === 86400) return 'D';
      if (s === 7 * 86400) return 'W';
      return `${s / 86400}D`;
    }
    case 'tick':
      return `${spec.n} Tick`;
    case 'volume':
      return `${spec.n} Vol`;
    case 'delta':
      return `${spec.n} Delta`;
    case 'range':
      return `Range ${spec.ticks}`;
  }
}

function newBar(t: number, tr: Trade): Bar {
  return {
    t,
    tEnd: tr.ts,
    o: tr.px,
    h: tr.px,
    l: tr.px,
    c: tr.px,
    vol: 0,
    buy: 0,
    sell: 0,
    delta: 0,
    maxDelta: 0,
    minDelta: 0,
    trades: 0,
    clusters: new Map(),
    closed: false,
  };
}

function addToBar(bar: Bar, tr: Trade): void {
  bar.tEnd = tr.ts;
  if (tr.px > bar.h) bar.h = tr.px;
  if (tr.px < bar.l) bar.l = tr.px;
  bar.c = tr.px;
  bar.vol += tr.qty;
  bar.trades += 1;
  let cl = bar.clusters.get(tr.px);
  if (!cl) {
    cl = { bid: 0, ask: 0, trades: 0, maxTrade: 0 };
    bar.clusters.set(tr.px, cl);
  }
  cl.trades += 1;
  if (tr.qty > cl.maxTrade) cl.maxTrade = tr.qty;
  if (tr.side === 'buy') {
    bar.buy += tr.qty;
    cl.ask += tr.qty;
  } else if (tr.side === 'sell') {
    bar.sell += tr.qty;
    cl.bid += tr.qty;
  }
  bar.delta = bar.buy - bar.sell;
  if (bar.delta > bar.maxDelta) bar.maxDelta = bar.delta;
  if (bar.delta < bar.minDelta) bar.minDelta = bar.delta;
}

/**
 * Incremental bar builder (Live Pipeline stage 7). The same `add` path is used for history
 * and live, so bulk and incremental builds are identical by construction.
 */
export class BarSeries {
  readonly bars: Bar[] = [];
  /** Bumped on any change. */
  version = 0;

  constructor(readonly spec: BarSpec) {}

  get last(): Bar | undefined {
    return this.bars[this.bars.length - 1];
  }

  /** Adds a trade. Returns true when a new bar was opened. */
  add(tr: Trade): boolean {
    const spec = this.spec;
    const last = this.last;
    this.version++;
    if (spec.kind === 'time') {
      const t = Math.floor(tr.ts / spec.ms) * spec.ms;
      if (!last || t > last.t) {
        if (last) last.closed = true;
        const b = newBar(t, tr);
        addToBar(b, tr);
        this.bars.push(b);
        return true;
      }
      addToBar(last, tr);
      return false;
    }
    if (spec.kind === 'range') {
      if (!last || last.closed || Math.max(last.h, tr.px) - Math.min(last.l, tr.px) > spec.ticks) {
        if (last) last.closed = true;
        const b = newBar(tr.ts, tr);
        addToBar(b, tr);
        this.bars.push(b);
        return true;
      }
      addToBar(last, tr);
      return false;
    }
    let opened = false;
    let bar = last;
    if (!bar || bar.closed) {
      bar = newBar(tr.ts, tr);
      this.bars.push(bar);
      opened = true;
    }
    addToBar(bar, tr);
    if (
      (spec.kind === 'tick' && bar.trades >= spec.n) ||
      (spec.kind === 'volume' && bar.vol >= spec.n) ||
      (spec.kind === 'delta' && Math.abs(bar.delta) >= spec.n)
    ) {
      bar.closed = true;
    }
    return opened;
  }

  addAll(trades: readonly Trade[]): void {
    for (const t of trades) this.add(t);
  }

  static build(spec: BarSpec, trades: readonly Trade[]): BarSeries {
    const s = new BarSeries(spec);
    s.addAll(trades);
    return s;
  }

  /** Index of the bar containing time t (binary search on open time). */
  indexAt(t: number): number {
    const b = this.bars;
    let lo = 0;
    let hi = b.length - 1;
    if (hi < 0) return -1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (b[mid]!.t <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}

export const TIMEFRAME_PRESETS: { row: string; specs: BarSpec[] }[] = [
  {
    row: 'Minute',
    specs: [1, 5, 10, 15, 30, 60, 240, 1440, 10080].map((m) => ({ kind: 'time', ms: m * 60_000 })),
  },
  { row: 'Seconds', specs: [1, 5, 10, 15, 30].map((s) => ({ kind: 'time', ms: s * 1000 })) },
  { row: 'Tick', specs: [1, 50, 144, 500, 1500].map((n) => ({ kind: 'tick', n })) },
  { row: 'Volume', specs: [100, 300, 500, 1000].map((n) => ({ kind: 'volume', n })) },
  { row: 'Delta', specs: [500, 1000, 1500].map((n) => ({ kind: 'delta', n })) },
  { row: 'Range', specs: [4, 8].map((ticks) => ({ kind: 'range', ticks })) },
];
