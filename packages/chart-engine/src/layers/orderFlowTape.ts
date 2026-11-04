import { formatQty, type OrderBook, type Trade } from '@htflow/market-data';
import type { ChartLayer, ChartView } from '../types';
import { clamp, rgba } from './util';

/**
 * Smart-print buffer: combines prints with the same timestamp and aggressor (FIFO order)
 * and keeps only prints >= minQty. Incremental — appends as the store grows.
 */
export class PrintBuffer {
  prints: Trade[] = [];
  private consumed = 0;
  private source: Trade[] | null = null;
  constructor(
    public minQty = 1,
    public combine = true,
  ) {}

  update(trades: Trade[]): Trade[] {
    if (this.source !== trades || this.consumed > trades.length) {
      this.source = trades;
      this.consumed = 0;
      this.prints = [];
    }
    const out = this.prints;
    let pending: Trade | null = null;
    for (let i = this.consumed; i < trades.length; i++) {
      const t = trades[i]!;
      if (pending !== null && this.combine && pending.ts === t.ts && pending.side === t.side) {
        const cur: Trade = pending;
        pending = { ts: cur.ts, px: t.px, qty: cur.qty + t.qty, side: cur.side, id: cur.id };
        continue;
      }
      if (pending !== null && pending.qty >= this.minQty) out.push(pending);
      pending = { ts: t.ts, px: t.px, qty: t.qty, side: t.side, id: t.id };
    }
    if (pending && pending.qty >= this.minQty) out.push(pending);
    this.consumed = trades.length;
    if (out.length > 200_000) this.prints = out.slice(-150_000);
    return this.prints;
  }

  reset(): void {
    this.source = null;
  }
}

/** Every print as a numbered circle moving left → right at its price (Order Flow tape chart). */
export class TapeBubblesLayer implements ChartLayer {
  readonly id = 'tape-bubbles';
  constructor(
    private prints: () => Trade[],
    private qtyPrecision: () => number,
  ) {}

  priceRange(i0: number, i1: number): [number, number] | null {
    const ps = this.prints();
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = Math.max(0, i0); i <= i1 && i < ps.length; i++) {
      const px = ps[i]!.px;
      if (px < lo) lo = px;
      if (px > hi) hi = px;
    }
    return Number.isFinite(lo) ? [lo - 6, hi + 6] : null;
  }

  draw(v: ChartView): void {
    const ps = this.prints();
    const { ctx, palette: p } = v;
    let maxQ = 0;
    for (let i = v.i0; i <= v.i1; i++) maxQ = Math.max(maxQ, ps[i]?.qty ?? 0);
    if (maxQ <= 0) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(v.plot.x, 0, v.plot.w, v.plot.h);
    ctx.clip();
    // Connecting price path.
    ctx.strokeStyle = rgba(p.textTertiary, 0.6);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = v.i0; i <= v.i1; i++) {
      const t = ps[i]!;
      if (i === v.i0) ctx.moveTo(v.xOf(i), v.yOf(t.px));
      else ctx.lineTo(v.xOf(i), v.yOf(t.px));
    }
    ctx.stroke();
    const prec = this.qtyPrecision();
    for (let i = v.i0; i <= v.i1; i++) {
      const t = ps[i]!;
      const r = clamp(6 + Math.sqrt(t.qty / maxQ) * 16, 6, Math.max(7, v.slotWidth * 1.6));
      const x = v.xOf(i);
      const y = v.yOf(t.px);
      const col = t.side === 'buy' ? p.up : t.side === 'sell' ? p.down : p.textSecondary;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = rgba(col, 0.85);
      ctx.fill();
      if (r >= 7) {
        ctx.fillStyle = '#fff';
        ctx.font = v.font(r > 12 ? 11 : 9, 600);
        ctx.textAlign = 'center';
        ctx.fillText(formatQty(t.qty, prec > 0 && t.qty < 1 ? prec : 0), x, y + 0.5);
      }
    }
    ctx.restore();
  }
}

/** Resting book behind the tape: ask side red, bid side green, best bid/ask and largest-level lines. */
export class DomBackdropLayer implements ChartLayer {
  readonly id = 'dom-backdrop';
  width = 124;
  constructor(private book: () => OrderBook) {}

  rightGutter() {
    return this.width;
  }

  draw(v: ChartView): void {
    const b = this.book();
    const { ctx, palette: p } = v;
    const r = v.right;
    if (Number.isNaN(b.bestBid) || Number.isNaN(b.bestAsk)) return;
    const yAsk = v.yOf(b.bestAsk + 0.5);
    const yBid = v.yOf(b.bestBid - 0.5);
    ctx.fillStyle = rgba(p.down, 0.13);
    ctx.fillRect(r.x, 0, r.w, Math.max(0, yAsk));
    ctx.fillStyle = rgba(p.up, 0.11);
    ctx.fillRect(r.x, yBid, r.w, Math.max(0, r.h - yBid));
    // Resting size per level as faint bars.
    let max = 0;
    let bigPx = Number.NaN;
    const lo = Math.floor(v.priceMin);
    const hi = Math.ceil(v.priceMax);
    for (let px = lo; px <= hi; px++) {
      const q = (b.bids.get(px) ?? 0) + (b.asks.get(px) ?? 0);
      if (q > max) {
        max = q;
        bigPx = px;
      }
    }
    if (max > 0) {
      const h = Math.max(1, v.tickPx - 1);
      for (let px = lo; px <= hi; px++) {
        const bq = b.bids.get(px);
        const aq = b.asks.get(px);
        const q = bq ?? aq ?? 0;
        if (!q) continue;
        ctx.fillStyle = rgba(bq ? p.up : p.down, 0.28);
        ctx.fillRect(r.x, v.yOf(px + 0.5), (q / max) * r.w * 0.9, h);
      }
    }
    for (const [px, col] of [
      [b.bestAsk, p.down],
      [b.bestBid, p.up],
    ] as const) {
      const y = Math.round(v.yOf(px)) + 0.5;
      ctx.strokeStyle = col;
      ctx.beginPath();
      ctx.moveTo(v.plot.x, y);
      ctx.lineTo(r.x + r.w, y);
      ctx.stroke();
    }
    if (!Number.isNaN(bigPx)) {
      const y = Math.round(v.yOf(bigPx)) + 0.5;
      ctx.strokeStyle = p.warning;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(r.x, y);
      ctx.lineTo(r.x + r.w, y);
      ctx.stroke();
    }
  }
}
