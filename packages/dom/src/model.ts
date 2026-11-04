import type { OrderBook, Trade } from '@htflow/market-data';

/**
 * DOM derived data per price (P15): session volume, recent buys/sells at price,
 * and resting-size change vs a reference snapshot taken every `changeWindowMs`.
 */
export class DomModel {
  readonly session = new Map<number, number>();
  readonly recentBuys = new Map<number, number>();
  readonly recentSells = new Map<number, number>();
  private recent: Trade[] = [];
  private refBids = new Map<number, number>();
  private refAsks = new Map<number, number>();
  private refAt = 0;
  private consumed = 0;
  private source: Trade[] | null = null;
  sessionStart = 0;

  constructor(
    public recentWindowMs = 10_000,
    public changeWindowMs = 5_000,
  ) {}

  /** Consumes new trades from the store's trade array (incremental). */
  update(trades: Trade[], book: OrderBook, now: number): void {
    const start = Math.floor(now / 86_400_000) * 86_400_000;
    if (this.source !== trades || start !== this.sessionStart || this.consumed > trades.length) {
      this.source = trades;
      this.sessionStart = start;
      this.session.clear();
      this.recent = [];
      // Binary search the session start.
      let lo = 0;
      let hi = trades.length;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (trades[m]!.ts < start) lo = m + 1;
        else hi = m;
      }
      this.consumed = lo;
    }
    for (let i = this.consumed; i < trades.length; i++) {
      const t = trades[i]!;
      this.session.set(t.px, (this.session.get(t.px) ?? 0) + t.qty);
      this.recent.push(t);
    }
    this.consumed = trades.length;
    const cutoff = now - this.recentWindowMs;
    let drop = 0;
    while (drop < this.recent.length && this.recent[drop]!.ts < cutoff) drop++;
    if (drop) this.recent.splice(0, drop);
    this.recentBuys.clear();
    this.recentSells.clear();
    for (const t of this.recent) {
      const m = t.side === 'buy' ? this.recentBuys : t.side === 'sell' ? this.recentSells : null;
      if (m) m.set(t.px, (m.get(t.px) ?? 0) + t.qty);
    }
    if (now - this.refAt >= this.changeWindowMs) {
      this.refBids = new Map(book.bids);
      this.refAsks = new Map(book.asks);
      this.refAt = now;
    }
  }

  bidChange(px: number, book: OrderBook): number {
    return (book.bids.get(px) ?? 0) - (this.refBids.get(px) ?? 0);
  }

  askChange(px: number, book: OrderBook): number {
    return (book.asks.get(px) ?? 0) - (this.refAsks.get(px) ?? 0);
  }
}
