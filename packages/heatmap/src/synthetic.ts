import {
  Rng,
  type BookSnapshot,
  type DepthColumn,
  type Level,
  type Trade,
} from '@htflow/market-data';

export interface SyntheticOptions {
  seed: number;
  /** Start price in ticks (CL ≈ 91.50 → 9150 at 0.01). */
  startPx: number;
  /** Levels per side. */
  levels: number;
  /** Column interval (ms). */
  intervalMs: number;
  /** Mean resting size at the touch (CL ≈ 8–15 lots). */
  baseSize: number;
  /** Mean trades per column. */
  tradesPerColumn: number;
  startT: number;
}

const DEFAULTS: SyntheticOptions = {
  seed: 7,
  startPx: 9150,
  levels: 150,
  intervalMs: 250,
  baseSize: 9,
  tradesPerColumn: 6,
  startT: Date.UTC(2026, 10, 12, 14, 30),
};

/**
 * Seeded CL-like order book stream for the heatmap stress test and benchmarks: a random-walk touch,
 * persistent walls, short-lived pulled orders (spoofs) and a refilling iceberg.
 */
export class SyntheticBook {
  readonly o: SyntheticOptions;
  t: number;
  mid: number;
  private rng: Rng;
  private bids = new Map<number, number>();
  private asks = new Map<number, number>();
  private walls: { px: number; qty: number; until: number }[] = [];
  private spoof: { px: number; qty: number; until: number } | null = null;
  private iceberg: { px: number; shown: number; until: number } | null = null;
  private tradeId = 1;

  constructor(opts: Partial<SyntheticOptions> = {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.rng = new Rng(this.o.seed);
    this.t = this.o.startT;
    this.mid = this.o.startPx;
    for (let k = 1; k <= this.o.levels; k++) {
      this.bids.set(this.mid - k, this.levelSize(k));
      this.asks.set(this.mid + k, this.levelSize(k));
    }
  }

  private levelSize(dist: number): number {
    const r = this.rng;
    const base = this.o.baseSize * (1 + dist * 0.025);
    return Math.max(1, Math.round(base * Math.exp(r.normal() * 0.45)));
  }

  get bestBid(): number {
    return this.mid - 1;
  }

  get bestAsk(): number {
    return this.mid + 1;
  }

  /** Advances one column and returns it with the trades printed during it. */
  step(): { col: DepthColumn; trades: Trade[] } {
    const r = this.rng;
    const o = this.o;
    this.t += o.intervalMs;
    const trades: Trade[] = [];
    // Trades at the touch.
    const n = r.poisson(o.tradesPerColumn);
    let net = 0;
    for (let k = 0; k < n; k++) {
      const buy = r.next() < 0.5;
      const qty = Math.max(1, Math.round(Math.exp(r.normal() * 0.9)));
      net += buy ? qty : -qty;
      trades.push({
        ts: this.t - o.intervalMs + ((k + 1) / (n + 1)) * o.intervalMs,
        px: buy ? this.bestAsk : this.bestBid,
        qty,
        side: buy ? 'buy' : 'sell',
        id: this.tradeId++,
      });
    }
    // Iceberg: hidden size at a price near the touch that keeps refilling.
    if (this.iceberg && this.t < this.iceberg.until) {
      const ib = this.iceberg;
      if (Math.abs(ib.px - this.mid) <= 2) {
        const qty = ib.shown + r.int(1, 4);
        const buy = ib.px > this.mid;
        trades.push({
          ts: this.t - 1,
          px: ib.px,
          qty,
          side: buy ? 'buy' : 'sell',
          id: this.tradeId++,
        });
      }
    } else if (r.next() < 0.004) {
      const side = r.next() < 0.5 ? -1 : 1;
      this.iceberg = { px: this.mid + side * 2, shown: r.int(3, 6), until: this.t + 20_000 };
    } else this.iceberg = null;
    // Touch moves with order flow, bounded random walk.
    const drift = net > 6 ? 1 : net < -6 ? -1 : r.next() < 0.04 ? (r.next() < 0.5 ? -1 : 1) : 0;
    if (drift !== 0) this.shift(drift);
    // Resting liquidity churn.
    for (const book of [this.bids, this.asks]) {
      for (const [px, q] of book) {
        const u = r.next();
        if (u < 0.06) book.set(px, Math.max(1, Math.round(q * r.range(0.7, 1.35))));
        else if (u < 0.065) book.delete(px);
      }
    }
    for (let k = 1; k <= o.levels; k++) {
      if (!this.bids.has(this.mid - k) && r.next() < 0.2)
        this.bids.set(this.mid - k, this.levelSize(k));
      if (!this.asks.has(this.mid + k) && r.next() < 0.2)
        this.asks.set(this.mid + k, this.levelSize(k));
    }
    // Large walls (large-order outlines / lifetime colours).
    if (r.next() < 0.01) {
      const side = r.next() < 0.5 ? -1 : 1;
      const px = this.mid + side * r.int(5, 60);
      this.walls.push({
        px,
        qty: o.baseSize * r.range(12, 30),
        until: this.t + r.range(20_000, 240_000),
      });
    }
    this.walls = this.walls.filter((w) => w.until > this.t && Math.abs(w.px - this.mid) > 1);
    // Spoof: big order a few ticks away, pulled after 1–3 s without trading.
    if (this.spoof && this.t >= this.spoof.until) this.spoof = null;
    else if (!this.spoof && r.next() < 0.01) {
      const side = r.next() < 0.5 ? -1 : 1;
      this.spoof = {
        px: this.mid + side * r.int(3, 8),
        qty: o.baseSize * r.range(15, 35),
        until: this.t + r.range(1000, 3000),
      };
    }
    return { col: this.column(), trades };
  }

  private shift(d: number): void {
    this.mid += d;
    for (const [px] of this.bids) if (px >= this.mid) this.bids.delete(px);
    for (const [px] of this.asks) if (px <= this.mid) this.asks.delete(px);
    for (const [px] of this.bids) if (px < this.mid - this.o.levels) this.bids.delete(px);
    for (const [px] of this.asks) if (px > this.mid + this.o.levels) this.asks.delete(px);
  }

  private merged(): { bids: Map<number, number>; asks: Map<number, number> } {
    const bids = new Map(this.bids);
    const asks = new Map(this.asks);
    const add = (px: number, q: number) => {
      const m = px < this.mid ? bids : px > this.mid ? asks : null;
      if (m) m.set(px, (m.get(px) ?? 0) + q);
    };
    for (const w of this.walls) add(w.px, w.qty);
    if (this.spoof) add(this.spoof.px, this.spoof.qty);
    if (this.iceberg) {
      const m = this.iceberg.px < this.mid ? bids : asks;
      m.set(this.iceberg.px, this.iceberg.shown);
    }
    return { bids, asks };
  }

  column(): DepthColumn {
    const { bids, asks } = this.merged();
    const n = bids.size + asks.size;
    const pxs = new Int32Array(n);
    const qtys = new Float32Array(n);
    let k = 0;
    for (const [px, q] of bids) {
      pxs[k] = px;
      qtys[k++] = q;
    }
    for (const [px, q] of asks) {
      pxs[k] = px;
      qtys[k++] = q;
    }
    return { t: this.t, bestBid: this.bestBid, bestAsk: this.bestAsk, pxs, qtys };
  }

  snapshot(): BookSnapshot {
    const { bids, asks } = this.merged();
    const b: Level[] = [...bids].sort((x, y) => y[0] - x[0]);
    const a: Level[] = [...asks].sort((x, y) => x[0] - y[0]);
    return { ts: this.t, bids: b, asks: a };
  }
}

/** n columns of synthetic history (benchmarks, tests, stress test warm-up). */
export function syntheticHistory(
  n: number,
  opts: Partial<SyntheticOptions> = {},
): { depth: DepthColumn[]; trades: Trade[]; book: SyntheticBook } {
  const book = new SyntheticBook(opts);
  const depth: DepthColumn[] = [];
  const trades: Trade[] = [];
  for (let i = 0; i < n; i++) {
    const s = book.step();
    depth.push(s.col);
    for (const t of s.trades) trades.push(t);
  }
  trades.sort((a, b) => a.ts - b.ts);
  return { depth, trades, book };
}
