import type { BookDelta, BookSnapshot, Level } from './types';

/**
 * Full L2 book per instrument (Live Pipeline stage 3). Prices are integer ticks.
 * Best bid / ask are maintained incrementally; removing the best level triggers a scan.
 */
export class OrderBook {
  readonly bids = new Map<number, number>();
  readonly asks = new Map<number, number>();
  private _bestBid = Number.NaN;
  private _bestAsk = Number.NaN;
  /** Increments on every change; consumers use it as a cheap dirty flag. */
  version = 0;

  get bestBid(): number {
    return this._bestBid;
  }

  get bestAsk(): number {
    return this._bestAsk;
  }

  get mid(): number {
    if (Number.isNaN(this._bestBid)) return this._bestAsk;
    if (Number.isNaN(this._bestAsk)) return this._bestBid;
    return (this._bestBid + this._bestAsk) / 2;
  }

  clear(): void {
    this.bids.clear();
    this.asks.clear();
    this._bestBid = Number.NaN;
    this._bestAsk = Number.NaN;
    this.version++;
  }

  applySnapshot(s: BookSnapshot): void {
    this.bids.clear();
    this.asks.clear();
    for (const [px, q] of s.bids) if (q > 0) this.bids.set(px, q);
    for (const [px, q] of s.asks) if (q > 0) this.asks.set(px, q);
    this.recalcBest();
    this.version++;
  }

  applyDelta(d: BookDelta): void {
    if (d.side === 'buy') {
      if (d.qty <= 0) {
        this.bids.delete(d.px);
        if (d.px === this._bestBid) this._bestBid = maxKey(this.bids);
      } else {
        this.bids.set(d.px, d.qty);
        if (Number.isNaN(this._bestBid) || d.px > this._bestBid) this._bestBid = d.px;
      }
    } else {
      if (d.qty <= 0) {
        this.asks.delete(d.px);
        if (d.px === this._bestAsk) this._bestAsk = minKey(this.asks);
      } else {
        this.asks.set(d.px, d.qty);
        if (Number.isNaN(this._bestAsk) || d.px < this._bestAsk) this._bestAsk = d.px;
      }
    }
    this.version++;
  }

  applyDeltas(ds: readonly BookDelta[]): void {
    for (const d of ds) this.applyDelta(d);
  }

  /** Size resting at a price (bid side below/at best bid, ask side above). */
  sizeAt(px: number): { bid: number; ask: number } {
    return { bid: this.bids.get(px) ?? 0, ask: this.asks.get(px) ?? 0 };
  }

  /** Top N levels per side, best first. */
  top(n: number): { bids: Level[]; asks: Level[] } {
    const bids = [...this.bids.entries()].sort((a, b) => b[0] - a[0]).slice(0, n);
    const asks = [...this.asks.entries()].sort((a, b) => a[0] - b[0]).slice(0, n);
    return { bids, asks };
  }

  snapshot(ts: number, depth = Infinity): BookSnapshot {
    const { bids, asks } = this.top(depth);
    return { ts, bids, asks };
  }

  /** Cumulative size of the best n levels per side. */
  depthWithin(ticks: number): { bid: number; ask: number } {
    let bid = 0;
    let ask = 0;
    for (const [px, q] of this.bids) if (px >= this._bestBid - ticks) bid += q;
    for (const [px, q] of this.asks) if (px <= this._bestAsk + ticks) ask += q;
    return { bid, ask };
  }

  private recalcBest(): void {
    this._bestBid = maxKey(this.bids);
    this._bestAsk = minKey(this.asks);
  }
}

function maxKey(m: Map<number, number>): number {
  let best = Number.NaN;
  for (const k of m.keys()) if (Number.isNaN(best) || k > best) best = k;
  return best;
}

function minKey(m: Map<number, number>): number {
  let best = Number.NaN;
  for (const k of m.keys()) if (Number.isNaN(best) || k < best) best = k;
  return best;
}
