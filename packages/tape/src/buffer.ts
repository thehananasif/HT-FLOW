import type { Aggressor, Trade } from '@htflow/market-data';

/**
 * One tape row. A "smart print" is the reconstruction of a single aggressive order from the
 * individual fills the venue reports for it (same timestamp + same aggressor, or optionally all
 * same-side fills inside a short time window).
 */
export interface SmartPrint {
  /** Time of the first fill, epoch ms. */
  ts: number;
  /** Time of the last fill, epoch ms. */
  tsEnd: number;
  /** Last fill price (ticks) — the price the order finished at. */
  px: number;
  /** First fill price (ticks). */
  pxFirst: number;
  pxLow: number;
  pxHigh: number;
  /** Volume-weighted average price (fractional ticks). */
  vwap: number;
  qty: number;
  side: Aggressor;
  /** Number of fills aggregated into this print. */
  trades: number;
  /** Best bid / ask (ticks) when the print was seen; NaN when unknown. */
  bid: number;
  ask: number;
  /** Cumulative delta (buy − sell aggressor volume) after this print. */
  cvd: number;
}

/**
 * - `none`: every fill is its own row.
 * - `timestamp`: fills with the same timestamp and aggressor merge (smart print reconstruction).
 * - `window`: same-aggressor fills within `windowMs` of the print's first fill merge.
 */
export type AggregateMode = 'none' | 'timestamp' | 'window';

export interface AggregateOptions {
  mode: AggregateMode;
  /** Only for `window` mode. */
  windowMs: number;
}

export const DEFAULT_AGGREGATE: AggregateOptions = { mode: 'timestamp', windowMs: 50 };

const SIDE_CODE: Record<Aggressor, number> = { buy: 1, sell: -1, unknown: 0 };
const CODE_SIDE: Aggressor[] = ['sell', 'unknown', 'buy'];

/** Signed volume of a fill: + for buy aggressor, − for sell, 0 when unknown. */
export function signedQty(t: Pick<Trade, 'qty' | 'side'>): number {
  return t.side === 'buy' ? t.qty : t.side === 'sell' ? -t.qty : 0;
}

/** Net delta of a run of trades. */
export function deltaOf(trades: readonly Trade[], from = 0, to = trades.length): number {
  let d = 0;
  for (let i = from; i < to; i++) d += signedQty(trades[i]!);
  return d;
}

/**
 * Ring buffer of smart prints stored as typed arrays (no per-print allocation, so the tape keeps
 * up with thousands of prints per second). Index 0 of the read API is the newest print.
 */
export class TapeBuffer {
  readonly capacity: number;
  private readonly mask: number;
  private readonly ts: Float64Array;
  private readonly tsEnd: Float64Array;
  private readonly px: Float64Array;
  private readonly pxFirst: Float64Array;
  private readonly pxLow: Float64Array;
  private readonly pxHigh: Float64Array;
  private readonly notional: Float64Array;
  private readonly qty: Float64Array;
  private readonly side: Int8Array;
  private readonly count: Float64Array;
  private readonly bid: Float64Array;
  private readonly ask: Float64Array;
  private readonly cvdArr: Float64Array;
  /** Prints ever created (monotonic). */
  total = 0;
  /** Bumped on every change (new print or merge). */
  version = 0;
  /** Running cumulative delta. */
  cvd = 0;
  agg: AggregateOptions;

  constructor(capacity = 65_536, agg: AggregateOptions = DEFAULT_AGGREGATE) {
    let cap = 1;
    while (cap < capacity) cap <<= 1;
    this.capacity = cap;
    this.mask = cap - 1;
    this.ts = new Float64Array(cap);
    this.tsEnd = new Float64Array(cap);
    this.px = new Float64Array(cap);
    this.pxFirst = new Float64Array(cap);
    this.pxLow = new Float64Array(cap);
    this.pxHigh = new Float64Array(cap);
    this.notional = new Float64Array(cap);
    this.qty = new Float64Array(cap);
    this.side = new Int8Array(cap);
    this.count = new Float64Array(cap);
    this.bid = new Float64Array(cap);
    this.ask = new Float64Array(cap);
    this.cvdArr = new Float64Array(cap);
    this.agg = { ...agg };
  }

  /** Prints currently held (≤ capacity). */
  get size(): number {
    return Math.min(this.total, this.capacity);
  }

  clear(cvdStart = 0): void {
    this.total = 0;
    this.cvd = cvdStart;
    this.version++;
  }

  /** Adds one fill. Returns true when it started a new print, false when it merged into the last one. */
  push(t: Trade, bid = Number.NaN, ask = Number.NaN): boolean {
    const sc = SIDE_CODE[t.side];
    const d = sc * t.qty;
    this.cvd += d;
    this.version++;
    if (this.total > 0 && this.agg.mode !== 'none') {
      const i = (this.total - 1) & this.mask;
      const merge =
        this.side[i] === sc &&
        (this.agg.mode === 'timestamp'
          ? t.ts === this.ts[i]
          : t.ts - this.ts[i]! <= Math.max(0, this.agg.windowMs));
      if (merge) {
        this.tsEnd[i] = t.ts;
        this.px[i] = t.px;
        if (t.px < this.pxLow[i]!) this.pxLow[i] = t.px;
        if (t.px > this.pxHigh[i]!) this.pxHigh[i] = t.px;
        this.notional[i]! += t.px * t.qty;
        this.qty[i]! += t.qty;
        this.count[i]! += 1;
        if (!Number.isNaN(bid)) this.bid[i] = bid;
        if (!Number.isNaN(ask)) this.ask[i] = ask;
        this.cvdArr[i] = this.cvd;
        return false;
      }
    }
    const i = this.total & this.mask;
    this.ts[i] = t.ts;
    this.tsEnd[i] = t.ts;
    this.px[i] = t.px;
    this.pxFirst[i] = t.px;
    this.pxLow[i] = t.px;
    this.pxHigh[i] = t.px;
    this.notional[i] = t.px * t.qty;
    this.qty[i] = t.qty;
    this.side[i] = sc;
    this.count[i] = 1;
    this.bid[i] = bid;
    this.ask[i] = ask;
    this.cvdArr[i] = this.cvd;
    this.total++;
    return true;
  }

  pushAll(trades: readonly Trade[], from = 0, to = trades.length): void {
    for (let i = from; i < to; i++) this.push(trades[i]!);
  }

  private slot(k: number): number {
    return (this.total - 1 - k) & this.mask;
  }

  // ---- allocation-free accessors; k = 0 is the newest print, k < size ----
  tsAt(k: number): number {
    return this.ts[this.slot(k)]!;
  }
  pxAt(k: number): number {
    return this.px[this.slot(k)]!;
  }
  qtyAt(k: number): number {
    return this.qty[this.slot(k)]!;
  }
  /** 1 buy, −1 sell, 0 unknown. */
  sideAt(k: number): number {
    return this.side[this.slot(k)]!;
  }
  tradesAt(k: number): number {
    return this.count[this.slot(k)]!;
  }
  bidAt(k: number): number {
    return this.bid[this.slot(k)]!;
  }
  askAt(k: number): number {
    return this.ask[this.slot(k)]!;
  }
  cvdAt(k: number): number {
    return this.cvdArr[this.slot(k)]!;
  }

  /** Full print object (allocates). */
  get(k: number): SmartPrint {
    const i = this.slot(k);
    return {
      ts: this.ts[i]!,
      tsEnd: this.tsEnd[i]!,
      px: this.px[i]!,
      pxFirst: this.pxFirst[i]!,
      pxLow: this.pxLow[i]!,
      pxHigh: this.pxHigh[i]!,
      vwap: this.notional[i]! / this.qty[i]!,
      qty: this.qty[i]!,
      side: CODE_SIDE[this.side[i]! + 1]!,
      trades: this.count[i]!,
      bid: this.bid[i]!,
      ask: this.ask[i]!,
      cvd: this.cvdArr[i]!,
    };
  }

  /** Prints oldest → newest (allocates; for tests and exports). */
  toArray(): SmartPrint[] {
    const out: SmartPrint[] = [];
    for (let k = this.size - 1; k >= 0; k--) out.push(this.get(k));
    return out;
  }
}

/** Smart-print reconstruction of a trade list (oldest → newest). */
export function aggregatePrints(
  trades: readonly Trade[],
  agg: AggregateOptions = DEFAULT_AGGREGATE,
  cvdStart = 0,
): SmartPrint[] {
  const b = new TapeBuffer(Math.max(1, trades.length), agg);
  b.cvd = cvdStart;
  b.pushAll(trades);
  return b.toArray();
}
