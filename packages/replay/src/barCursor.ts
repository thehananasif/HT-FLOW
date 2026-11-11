import type { BarSpec, Trade } from '@htflow/market-data';

/**
 * Lightweight mirror of BarSeries.add's bar-boundary rules (no clusters), used to find where the
 * current bar ends for "step bar" and where it began for "step back bar".
 */
export class BarCursor {
  /** Bars opened so far. */
  bars = 0;
  /** Index (in the fed trade sequence) of the first trade of the current bar. */
  barStart = -1;
  private fed = 0;
  private t = 0;
  private h = 0;
  private l = 0;
  private trades = 0;
  private vol = 0;
  private buy = 0;
  private sell = 0;
  private closed = false;

  constructor(readonly spec: BarSpec) {}

  /** True when adding `tr` would open a new bar. */
  opensNewBar(tr: Trade): boolean {
    if (this.bars === 0) return true;
    const s = this.spec;
    switch (s.kind) {
      case 'time':
        return Math.floor(tr.ts / s.ms) * s.ms > this.t;
      case 'range':
        return this.closed || Math.max(this.h, tr.px) - Math.min(this.l, tr.px) > s.ticks;
      default:
        return this.closed;
    }
  }

  add(tr: Trade): void {
    const s = this.spec;
    if (this.opensNewBar(tr)) {
      this.bars++;
      this.barStart = this.fed;
      this.t = s.kind === 'time' ? Math.floor(tr.ts / s.ms) * s.ms : tr.ts;
      this.h = tr.px;
      this.l = tr.px;
      this.trades = 0;
      this.vol = 0;
      this.buy = 0;
      this.sell = 0;
      this.closed = false;
    }
    this.fed++;
    if (tr.px > this.h) this.h = tr.px;
    if (tr.px < this.l) this.l = tr.px;
    this.trades++;
    this.vol += tr.qty;
    if (tr.side === 'buy') this.buy += tr.qty;
    else if (tr.side === 'sell') this.sell += tr.qty;
    const delta = this.buy - this.sell;
    if (
      (s.kind === 'tick' && this.trades >= s.n) ||
      (s.kind === 'volume' && this.vol >= s.n) ||
      (s.kind === 'delta' && Math.abs(delta) >= s.n)
    )
      this.closed = true;
  }

  addAll(trades: readonly Trade[], from = 0, to = trades.length): this {
    for (let i = from; i < to; i++) this.add(trades[i]!);
    return this;
  }
}
