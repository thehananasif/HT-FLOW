import { Rng } from './rng';
import type { BookDelta, BookSnapshot, DepthColumn, Trade } from './types';

export interface SimConfig {
  seed: number;
  /** Starting price in ticks. */
  startPx: number;
  /** Average aggressive orders per second. */
  orderRate: number;
  /** Typical aggressive order size. */
  meanQty: number;
  /** Decimals for quantities (0 = lots). */
  qtyPrecision: number;
  /** Levels maintained on each side. */
  levels: number;
  /** Typical resting size per level. */
  baseDepth: number;
}

/**
 * Seeded order-flow market simulator behind MockFeed.
 * Aggressive orders consume resting liquidity, so price moves come from the order flow
 * itself — footprints, DOM, heatmap and tape all stay mutually consistent.
 */
export class MarketSimulator {
  t: number;
  readonly bids = new Map<number, number>();
  readonly asks = new Map<number, number>();
  bestBid: number;
  bestAsk: number;
  private rng: Rng;
  private drift = 0;
  private maintainedBid = Number.NaN;
  private maintainedAsk = Number.NaN;
  private tradeId = 1;
  private readonly unit: number;

  constructor(
    readonly cfg: SimConfig,
    t0: number,
  ) {
    this.t = t0;
    this.rng = new Rng(cfg.seed);
    this.unit = Math.pow(10, -cfg.qtyPrecision);
    this.bestBid = cfg.startPx - 1;
    this.bestAsk = cfg.startPx;
    for (let i = 0; i < cfg.levels; i++) {
      this.bids.set(this.bestBid - i, this.levelSize(i));
      this.asks.set(this.bestAsk + i, this.levelSize(i));
    }
  }

  snapshot(): BookSnapshot {
    const bids = [...this.bids.entries()].sort((a, b) => b[0] - a[0]);
    const asks = [...this.asks.entries()].sort((a, b) => a[0] - b[0]);
    return { ts: this.t, bids, asks };
  }

  depthColumn(maxLevels: number): DepthColumn {
    const n = Math.min(this.bids.size, maxLevels) + Math.min(this.asks.size, maxLevels);
    const pxs = new Int32Array(n);
    const qtys = new Float32Array(n);
    let i = 0;
    for (const [px, q] of this.bids) {
      if (px < this.bestBid - maxLevels + 1) continue;
      if (i >= n) break;
      pxs[i] = px;
      qtys[i++] = q;
    }
    for (const [px, q] of this.asks) {
      if (px > this.bestAsk + maxLevels - 1) continue;
      if (i >= n) break;
      pxs[i] = px;
      qtys[i++] = q;
    }
    return {
      t: this.t,
      bestBid: this.bestBid,
      bestAsk: this.bestAsk,
      pxs: pxs.subarray(0, i),
      qtys: qtys.subarray(0, i),
    };
  }

  /** Advances the simulation by dtMs, appending generated events. */
  step(dtMs: number, trades: Trade[], deltas: BookDelta[]): void {
    const rng = this.rng;
    const dtS = dtMs / 1000;
    this.t += dtMs;
    // Slowly varying order-flow imbalance (regimes of buying / selling pressure).
    this.drift += rng.normal() * 0.06 * Math.sqrt(dtS);
    this.drift *= Math.pow(0.97, dtS);
    if (this.drift > 0.22) this.drift = 0.22;
    if (this.drift < -0.22) this.drift = -0.22;
    const pBuy = 0.5 + this.drift;

    const n = rng.poisson(this.cfg.orderRate * dtS);
    for (let k = 0; k < n; k++) {
      const ts = this.t - dtMs + ((k + 1) / (n + 1)) * dtMs;
      this.execute(rng.next() < pBuy ? 'buy' : 'sell', this.sampleQty(), ts, trades, deltas);
    }
    this.churn(dtS, deltas);
    this.repairSpread(deltas, pBuy);
    this.trimAndExtend(deltas);
  }

  private levelSize(dist: number): number {
    const base = this.cfg.baseDepth * (0.35 + this.rng.next() * 1.3) * (1 + dist * 0.015);
    return this.roundQty(base);
  }

  private roundQty(q: number): number {
    const u = this.unit;
    return Math.max(u, Math.round(q / u) * u);
  }

  private sampleQty(): number {
    const rng = this.rng;
    let q = this.cfg.meanQty * Math.exp(rng.normal() * 0.8) * 0.75;
    if (rng.next() < 0.03) q *= rng.range(6, 25); // occasional big print
    return this.roundQty(q);
  }

  private execute(
    side: 'buy' | 'sell',
    qty: number,
    ts: number,
    trades: Trade[],
    deltas: BookDelta[],
  ): void {
    let rem = qty;
    const book = side === 'buy' ? this.asks : this.bids;
    let guard = 0;
    while (rem > 1e-12 && guard++ < 50) {
      const px = side === 'buy' ? this.bestAsk : this.bestBid;
      const size = book.get(px);
      if (size === undefined) {
        // Book side exhausted at the touch: move the touch one tick.
        if (side === 'buy') this.bestAsk++;
        else this.bestBid--;
        continue;
      }
      const take = Math.min(rem, size);
      const fill = this.roundQty(take);
      trades.push({ ts, px, qty: fill, side, id: this.tradeId++ });
      rem -= take;
      const left = size - take;
      if (left <= this.unit / 2) {
        book.delete(px);
        deltas.push({ side: side === 'buy' ? 'sell' : 'buy', px, qty: 0 });
        if (side === 'buy') this.bestAsk = nextKey(this.asks, this.bestAsk, 1);
        else this.bestBid = nextKey(this.bids, this.bestBid, -1);
      } else {
        const q = this.roundQty(left);
        book.set(px, q);
        deltas.push({ side: side === 'buy' ? 'sell' : 'buy', px, qty: q });
      }
    }
  }

  /** Random adds / cancels / walls across the book. */
  private churn(dtS: number, deltas: BookDelta[]): void {
    const rng = this.rng;
    const updates = rng.poisson(this.cfg.levels * 0.5 * dtS);
    for (let i = 0; i < updates; i++) {
      const bid = rng.next() < 0.5;
      const dist = Math.floor(-Math.log(1 - rng.next()) * this.cfg.levels * 0.18);
      if (dist >= this.cfg.levels) continue;
      const px = bid ? this.bestBid - dist : this.bestAsk + dist;
      const book = bid ? this.bids : this.asks;
      const cur = book.get(px) ?? 0;
      let q: number;
      const r = rng.next();
      if (r < 0.012 && dist > 3)
        q = this.roundQty(this.cfg.baseDepth * rng.range(8, 22)); // wall
      else if (r < 0.2 && cur > this.cfg.baseDepth * 4)
        q = this.levelSize(dist); // wall pulled
      else
        q = this.roundQty(
          Math.max(this.unit, cur * rng.range(0.7, 1.35) + rng.normal() * this.unit),
        );
      if (q === cur) continue;
      book.set(px, q);
      deltas.push({ side: bid ? 'buy' : 'sell', px, qty: q });
    }
  }

  private repairSpread(deltas: BookDelta[], pBuy: number): void {
    // Keep the market one tick wide most of the time: refill the gap from the stronger side.
    let guard = 0;
    while (this.bestAsk - this.bestBid > 1 && guard++ < 20) {
      if (this.rng.next() < pBuy) {
        const px = this.bestBid + 1;
        const q = this.levelSize(0);
        this.bids.set(px, q);
        this.bestBid = px;
        deltas.push({ side: 'buy', px, qty: q });
      } else {
        const px = this.bestAsk - 1;
        const q = this.levelSize(0);
        this.asks.set(px, q);
        this.bestAsk = px;
        deltas.push({ side: 'sell', px, qty: q });
      }
    }
  }

  private trimAndExtend(deltas: BookDelta[]): void {
    // Only aggressive orders delete levels, and they always move the touch — so the
    // book only needs maintenance when best bid/ask changed.
    if (this.bestBid === this.maintainedBid && this.bestAsk === this.maintainedAsk) return;
    this.maintainedBid = this.bestBid;
    this.maintainedAsk = this.bestAsk;
    const L = this.cfg.levels;
    for (const [px] of this.bids)
      if (px < this.bestBid - L) {
        this.bids.delete(px);
        deltas.push({ side: 'buy', px, qty: 0 });
      }
    for (const [px] of this.asks)
      if (px > this.bestAsk + L) {
        this.asks.delete(px);
        deltas.push({ side: 'sell', px, qty: 0 });
      }
    for (let i = 0; i < L; i++) {
      const b = this.bestBid - i;
      if (!this.bids.has(b)) {
        const q = this.levelSize(i);
        this.bids.set(b, q);
        deltas.push({ side: 'buy', px: b, qty: q });
      }
      const a = this.bestAsk + i;
      if (!this.asks.has(a)) {
        const q = this.levelSize(i);
        this.asks.set(a, q);
        deltas.push({ side: 'sell', px: a, qty: q });
      }
    }
  }
}

/** Next populated price after `px` in direction `dir` (books are near-contiguous, so probe first). */
function nextKey(m: Map<number, number>, px: number, dir: 1 | -1): number {
  for (let i = 1; i <= 8; i++) if (m.has(px + dir * i)) return px + dir * i;
  let best = dir > 0 ? Infinity : -Infinity;
  for (const k of m.keys()) if (dir > 0 ? k < best && k > px : k > best && k < px) best = k;
  return Number.isFinite(best) ? best : px + dir;
}
