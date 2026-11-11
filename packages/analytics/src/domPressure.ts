/** The parts of an order book DOM Pressure needs (OrderBook satisfies it). */
export interface BookLike {
  readonly bids: ReadonlyMap<number, number>;
  readonly asks: ReadonlyMap<number, number>;
  readonly bestBid: number;
  readonly bestAsk: number;
}

export interface DepthBand {
  bid: number;
  ask: number;
}

export const DOM_BANDS = [5, 10, 25] as const;
export type DomBand = (typeof DOM_BANDS)[number];

/**
 * Resting size within N ticks of the best bid / best ask (best level included), for several N
 * in one pass over the book.
 */
export function depthBands(book: BookLike, ticks: readonly number[]): DepthBand[] {
  const out = ticks.map(() => ({ bid: 0, ask: 0 }));
  const bb = book.bestBid;
  const ba = book.bestAsk;
  if (!Number.isNaN(bb))
    for (const [px, q] of book.bids) {
      const d = bb - px;
      if (d < 0) continue;
      for (let i = 0; i < ticks.length; i++) if (d <= ticks[i]!) out[i]!.bid += q;
    }
  if (!Number.isNaN(ba))
    for (const [px, q] of book.asks) {
      const d = px - ba;
      if (d < 0) continue;
      for (let i = 0; i < ticks.length; i++) if (d <= ticks[i]!) out[i]!.ask += q;
    }
  return out;
}

/** (bid − ask) / (bid + ask) in %, −100…+100; 0 for an empty book. */
export function imbalancePct(b: DepthBand): number {
  const t = b.bid + b.ask;
  return t > 0 ? ((b.bid - b.ask) / t) * 100 : 0;
}

export interface DomPressureReading {
  bid: number;
  ask: number;
  imbalance: number;
  /** Net change of resting size inside the band per second (bid + ask). */
  changePerSec: number;
  /** A side lost more than `pullPct` of its resting size since the previous sample. */
  pullBid: boolean;
  pullAsk: boolean;
}

/**
 * Samples the book (normally once per second) and derives liquidity change per second and
 * "pull" flags (a side losing more than `pullPct` % of its resting size between samples).
 */
export class DomPressureTracker {
  private prev: { t: number; bands: DepthBand[] } | null = null;
  private cur: { t: number; bands: DepthBand[] } | null = null;

  constructor(
    readonly bands: readonly number[] = DOM_BANDS,
    public pullPct = 30,
  ) {}

  sample(book: BookLike, now: number): void {
    if (this.cur && now <= this.cur.t) return;
    this.prev = this.cur;
    this.cur = { t: now, bands: depthBands(book, this.bands) };
  }

  reading(band: number): DomPressureReading | null {
    const i = this.bands.indexOf(band);
    if (i < 0 || !this.cur) return null;
    const c = this.cur.bands[i]!;
    const p = this.prev?.bands[i];
    const dt = this.prev ? (this.cur.t - this.prev.t) / 1000 : 0;
    const pull = (before: number, after: number) =>
      before > 0 && ((before - after) / before) * 100 > this.pullPct;
    return {
      bid: c.bid,
      ask: c.ask,
      imbalance: imbalancePct(c),
      changePerSec: p && dt > 0 ? (c.bid + c.ask - p.bid - p.ask) / dt : 0,
      pullBid: p ? pull(p.bid, c.bid) : false,
      pullAsk: p ? pull(p.ask, c.ask) : false,
    };
  }
}
