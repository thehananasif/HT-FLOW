import type { DepthColumn, Trade } from '@htflow/market-data';

export type BookSide = 'bid' | 'ask';

/** Liquidity that appeared and was pulled before it traded (P11 "spoof flashes"). */
export interface SpoofEvent {
  /** When the liquidity appeared / was pulled (ms). */
  t0: number;
  t1: number;
  px: number;
  side: BookSide;
  /** Largest size shown while it rested. */
  size: number;
  /** Volume that traded at the price while it rested. */
  traded: number;
}

/** Level where traded volume exceeded the displayed size while it kept refilling. */
export interface IcebergEvent {
  /** First detection time. */
  t: number;
  /** Last update time. */
  last: number;
  px: number;
  side: BookSide;
  traded: number;
  /** Largest size shown. */
  shown: number;
  refills: number;
}

export interface DetectorOptions {
  /** Minimum resting size for a pull to count as a spoof; 0 = auto (≥ `autoFactor` × column mean). */
  spoofMinSize: number;
  autoFactor: number;
  /** Liquidity resting longer than this is not a spoof. */
  spoofMaxLifeMs: number;
  /** Shorter than this is ignored (one-column flicker). */
  spoofMinLifeMs: number;
  /** A pull is a drop to ≤ this share of the largest size shown. */
  pullRatio: number;
  /** Traded volume at the price must stay below this share of the size. */
  maxTradedRatio: number;
  /** Ticks away from the touch at the time of the pull. */
  minDistanceTicks: number;
  /** Traded ≥ ratio × largest shown size flags an iceberg. */
  icebergRatio: number;
  /** Minimum traded volume for an iceberg. */
  icebergMinTraded: number;
  /** Keep at most this many events of each kind. */
  maxEvents: number;
}

export const DEFAULT_DETECTOR: DetectorOptions = {
  spoofMinSize: 0,
  autoFactor: 4,
  spoofMaxLifeMs: 10_000,
  spoofMinLifeMs: 400,
  pullRatio: 0.2,
  maxTradedRatio: 0.1,
  minDistanceTicks: 1,
  icebergRatio: 1.5,
  icebergMinTraded: 5,
  maxEvents: 2000,
};

interface LevelState {
  start: number;
  max: number;
  last: number;
  traded: number;
  /** Traded since the last refill. */
  pending: number;
  refills: number;
  side: BookSide;
  seen: number;
  iceberg: IcebergEvent | null;
}

/**
 * Tracks every resting price level across depth columns and emits spoof and iceberg events.
 * Feed columns in time order with the trades printed since the previous column.
 */
export class LiquidityTracker {
  opts: DetectorOptions;
  spoofs: SpoofEvent[] = [];
  icebergs: IcebergEvent[] = [];
  /** Time of the last column ingested. */
  lastT = -Infinity;
  private levels = new Map<number, LevelState>();
  private gen = 0;

  constructor(opts: Partial<DetectorOptions> = {}) {
    this.opts = { ...DEFAULT_DETECTOR, ...opts };
  }

  reset(): void {
    this.levels.clear();
    this.spoofs = [];
    this.icebergs = [];
    this.lastT = -Infinity;
  }

  ingest(col: DepthColumn, trades: readonly Trade[] = []): void {
    const o = this.opts;
    const gen = ++this.gen;
    // Trades hit levels as they rested before this snapshot.
    for (const tr of trades) {
      const st = this.levels.get(tr.px);
      if (!st) continue;
      st.traded += tr.qty;
      st.pending += tr.qty;
    }
    let sum = 0;
    for (let k = 0; k < col.qtys.length; k++) sum += col.qtys[k]!;
    const mean = col.qtys.length ? sum / col.qtys.length : 0;
    const minSpoof = o.spoofMinSize > 0 ? o.spoofMinSize : mean * o.autoFactor;

    for (let k = 0; k < col.pxs.length; k++) {
      const px = col.pxs[k]!;
      const q = col.qtys[k]!;
      if (q <= 0) continue;
      const side: BookSide = px <= col.bestBid ? 'bid' : 'ask';
      let st = this.levels.get(px);
      if (st && st.side !== side) {
        // Price crossed: the old level was consumed, start fresh.
        this.levels.delete(px);
        st = undefined;
      }
      if (!st) {
        st = {
          start: col.t,
          max: q,
          last: q,
          traded: 0,
          pending: 0,
          refills: 0,
          side,
          seen: gen,
          iceberg: null,
        };
        this.levels.set(px, st);
        continue;
      }
      st.seen = gen;
      if (st.pending > 0 && q >= st.last) {
        // Size came back after trading through it: a refill.
        st.refills++;
        st.pending = 0;
      }
      if (q > st.max * 2 && st.pending === 0 && !st.iceberg) {
        // A new large order joined the level: its life starts now.
        st.start = col.t;
        st.traded = 0;
        st.refills = 0;
      }
      if (q > st.max) st.max = q;
      // Partial pull without trades: treat as pulled liquidity, keep the rest as a new order.
      if (q <= st.max * o.pullRatio && st.traded <= st.max * o.maxTradedRatio) {
        this.maybeSpoof(st, px, col, minSpoof);
        st.start = col.t;
        st.max = q;
        st.traded = 0;
        st.pending = 0;
        st.refills = 0;
        st.iceberg = null;
      }
      st.last = q;
      this.checkIceberg(st, px, col.t);
    }
    // Levels that vanished.
    for (const [px, st] of this.levels) {
      if (st.seen === gen) continue;
      if (st.traded <= st.max * o.maxTradedRatio) this.maybeSpoof(st, px, col, minSpoof);
      this.levels.delete(px);
    }
    this.lastT = col.t;
    this.trim();
  }

  private checkIceberg(st: LevelState, px: number, t: number): void {
    const o = this.opts;
    if (st.traded < o.icebergMinTraded || st.traded < st.max * o.icebergRatio) return;
    if (st.iceberg) {
      st.iceberg.traded = st.traded;
      st.iceberg.refills = st.refills;
      st.iceberg.shown = st.max;
      st.iceberg.last = t;
      return;
    }
    st.iceberg = {
      t,
      last: t,
      px,
      side: st.side,
      traded: st.traded,
      shown: st.max,
      refills: st.refills,
    };
    this.icebergs.push(st.iceberg);
  }

  private maybeSpoof(st: LevelState, px: number, col: DepthColumn, minSize: number): void {
    const o = this.opts;
    const life = col.t - st.start;
    if (st.max < minSize || life > o.spoofMaxLifeMs || life < o.spoofMinLifeMs) return;
    const dist = st.side === 'bid' ? col.bestBid - px : px - col.bestAsk;
    if (dist < o.minDistanceTicks) return;
    this.spoofs.push({
      t0: st.start,
      t1: col.t,
      px,
      side: st.side,
      size: st.max,
      traded: st.traded,
    });
  }

  private trim(): void {
    const m = this.opts.maxEvents;
    if (this.spoofs.length > m * 1.25) this.spoofs = this.spoofs.slice(-m);
    if (this.icebergs.length > m * 1.25) this.icebergs = this.icebergs.slice(-m);
  }
}

/**
 * Keeps a tracker in step with a growing (and front-trimmed) depth array. Call `sync` before
 * drawing; it ingests only columns newer than the last one seen, in chunks so a long history never
 * blocks a frame for long.
 */
export class TrackerSync {
  readonly tracker: LiquidityTracker;

  constructor(opts: Partial<DetectorOptions> = {}) {
    this.tracker = new LiquidityTracker(opts);
  }

  /** Returns true when there is more history left to ingest. */
  sync(
    cols: readonly DepthColumn[],
    trades: (from: number, to: number) => readonly Trade[],
    budget = 2000,
  ): boolean {
    const tr = this.tracker;
    if (!cols.length) return false;
    // History replaced (instrument / replay seek) or trimmed past our cursor: rebuild.
    if (Number.isFinite(tr.lastT)) {
      const j = upperBound(cols, tr.lastT) - 1;
      if (j < 0 || cols[j]!.t !== tr.lastT) tr.reset();
    }
    let i = upperBound(cols, tr.lastT);
    const end = Math.min(cols.length, i + budget);
    let prevT = i > 0 ? cols[i - 1]!.t : cols[0]!.t - 1;
    for (; i < end; i++) {
      const c = cols[i]!;
      tr.ingest(c, trades(prevT + 1e-6, c.t));
      prevT = c.t;
    }
    return end < cols.length;
  }
}

function upperBound(cols: readonly DepthColumn[], t: number): number {
  let lo = 0;
  let hi = cols.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cols[mid]!.t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
