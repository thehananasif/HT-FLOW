import type { Instrument, Trade } from '@htflow/market-data';
import { TradeCursor, signedQty } from '@htflow/tape';
import { RollingFlow, marketPressure, type PressureRow } from './pressure';
import { PriceTracker, priceChange, type PriceChangeRow } from './priceChange';
import { DomPressureTracker, type BookLike, type DomPressureReading } from './domPressure';
import { CvdBarSeries, DIVERGENCE_TIMEFRAMES } from './divergence';

/** What the analytics need from a MarketStore (MarketStore satisfies it structurally). */
export interface StoreLike {
  readonly instrument: Instrument;
  readonly trades: readonly Trade[];
  readonly book: BookLike;
  readonly ready: boolean;
  readonly lastTs: number;
}

export interface SymbolAnalyticsOptions {
  sessionStartHourUtc?: number;
  /** Max trades consumed per update() (spreads a large history over several refreshes). */
  budget?: number;
  timeframes?: readonly number[];
}

/**
 * All scanner metrics for one instrument, updated incrementally from the store's trade array
 * (pull model: update() consumes only trades not seen yet).
 */
export class SymbolAnalytics {
  readonly flow: RollingFlow;
  readonly price: PriceTracker;
  readonly dom = new DomPressureTracker();
  readonly series: CvdBarSeries[];
  private readonly cursor = new TradeCursor();
  private readonly budget: number;
  cvd = 0;
  /** Feed time of the last update. */
  now = Number.NaN;
  /** False while the history backlog is still being consumed. */
  caughtUp = false;
  /** Bumped by every update that changed something. */
  version = 0;

  constructor(
    readonly store: StoreLike,
    o: SymbolAnalyticsOptions = {},
  ) {
    const h = o.sessionStartHourUtc ?? 0;
    this.flow = new RollingFlow(15 * 60_000, h);
    this.price = new PriceTracker(2 * 3_600_000, h);
    this.budget = o.budget ?? Number.POSITIVE_INFINITY;
    this.series = (o.timeframes ?? DIVERGENCE_TIMEFRAMES.map((t) => t.ms)).map(
      (ms) => new CvdBarSeries(ms),
    );
  }

  get instrument(): Instrument {
    return this.store.instrument;
  }

  /** Consumes new trades, closes finished bars and samples the book. `now` defaults to feed time. */
  update(now?: number): void {
    const s = this.store;
    if (!s.ready) return;
    const [from, to] = this.cursor.next(s.trades, this.budget);
    for (let i = from; i < to; i++) this.ingest(s.trades[i]!);
    this.caughtUp = to === s.trades.length;
    const last = s.trades[to - 1];
    const lastTs = last ? last.ts : this.now;
    this.now =
      now ?? Math.max(this.caughtUp ? s.lastTs || 0 : 0, Number.isNaN(lastTs) ? 0 : lastTs);
    if (this.caughtUp) {
      for (const b of this.series) b.closeUntil(this.now);
      this.dom.sample(s.book, this.now);
    }
    this.version++;
  }

  private ingest(t: Trade): void {
    this.cvd += signedQty(t);
    this.flow.add(t);
    this.price.add(t);
    for (const b of this.series) b.add(t.ts, t.px, t.qty, this.cvd);
  }

  pressure(): PressureRow {
    return marketPressure(this.flow, this.now);
  }

  change(): PriceChangeRow {
    return priceChange(this.price, this.now);
  }

  domReading(band: number): DomPressureReading | null {
    return this.dom.reading(band);
  }
}
