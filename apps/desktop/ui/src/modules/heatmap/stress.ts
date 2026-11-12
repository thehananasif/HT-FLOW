import { syntheticHistory, type SyntheticBook } from '@htflow/heatmap';
import { OrderBook, type DepthColumn, type Trade } from '@htflow/market-data';

export interface StressResult {
  seconds: number;
  frames: number;
  fps: number;
  /** Mean / 95th percentile time between frames (ms). */
  frameMs: number;
  p95FrameMs: number;
  /** Mean heat-buffer fill and whole-layer draw time (ms). */
  heatMs: number;
  drawMs: number;
  columns: number;
  passed: boolean;
}

/**
 * Replay-like stress test (P11 acceptance: CL-like replay at 30 fps): a seeded CL order book is
 * streamed at `speed`× real time (4 columns per second × speed) while the window measures frames.
 */
export class StressFeed {
  readonly depth: DepthColumn[];
  readonly trades: Trade[];
  readonly book = new OrderBook();
  private gen: SyntheticBook;
  private start = 0;
  private emitted = 0;
  private frameTimes: number[] = [];
  private heat: number[] = [];
  private draw: number[] = [];
  private last = 0;
  done: StressResult | null = null;

  constructor(
    readonly seconds = 12,
    readonly speed = 10,
    warmColumns = 2400,
  ) {
    const h = syntheticHistory(warmColumns, { seed: 42 });
    this.depth = h.depth;
    this.trades = h.trades;
    this.gen = h.book;
    this.book.applySnapshot(this.gen.snapshot());
  }

  tradesBetween = (from: number, to: number): Trade[] => {
    const a = lower(this.trades, from);
    const b = lower(this.trades, to + 1e-9);
    return this.trades.slice(a, b);
  };

  /** Appends the columns due by `now`; returns true while running. */
  tick(now: number): boolean {
    if (this.done) return false;
    if (!this.start) this.start = now;
    const due = Math.floor(((now - this.start) / 1000) * 4 * this.speed);
    while (this.emitted < due) {
      const s = this.gen.step();
      this.depth.push(s.col);
      for (const t of s.trades) this.trades.push(t);
      this.emitted++;
    }
    if (this.depth.length > 7200) this.depth.splice(0, this.depth.length - 7200);
    this.book.applySnapshot(this.gen.snapshot());
    return now - this.start < this.seconds * 1000;
  }

  /** Called after each rendered frame with the layer timings. */
  frame(now: number, heatMs: number, drawMs: number): void {
    if (this.last) this.frameTimes.push(now - this.last);
    this.last = now;
    this.heat.push(heatMs);
    this.draw.push(drawMs);
  }

  finish(): StressResult {
    const ft = this.frameTimes.slice().sort((a, b) => a - b);
    const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    const frameMs = mean(this.frameTimes);
    const fps = frameMs > 0 ? 1000 / frameMs : 0;
    this.done = {
      seconds: this.seconds,
      frames: this.frameTimes.length + 1,
      fps,
      frameMs,
      p95FrameMs: ft[Math.floor(ft.length * 0.95)] ?? 0,
      heatMs: mean(this.heat),
      drawMs: mean(this.draw),
      columns: this.emitted,
      passed: fps >= 30,
    };
    return this.done;
  }
}

function lower(trades: readonly Trade[], t: number): number {
  let lo = 0;
  let hi = trades.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (trades[mid]!.ts < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
