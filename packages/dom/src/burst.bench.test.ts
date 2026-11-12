import { describe, expect, it } from 'vitest';
import { OrderBook, type Instrument, type Trade } from '@htflow/market-data';
import type { Order } from '@htflow/trading';
import { DomModel } from './model';
import { DomLadder, type DomSurface } from './ladder';
import { BUILTIN_TEMPLATES, toggleColumn, type DomColumnId } from './templates';

/**
 * P15 acceptance: "20 updates / ms burst handled without frame drops". Each simulated 16 ms frame
 * receives 320 market updates (book deltas + trades) and then runs the DOM's per-frame work:
 * model.update + a full ladder draw with every column visible, on a headless 2D context.
 */

function headlessSurface(): DomSurface {
  const noop = () => {};
  const ctx = new Proxy(
    {},
    {
      get: (_t, k) => (k === 'measureText' ? () => ({ width: 10 }) : noop),
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
  return { width: 0, height: 0, getContext: () => ctx };
}

const inst: Instrument = {
  id: 'mock:ES',
  symbol: 'ES',
  displayName: 'ES',
  exchange: 'SIM',
  assetClass: 'future',
  tickSize: 0.25,
  pricePrecision: 2,
  qtyPrecision: 0,
  tickValue: 12.5,
  currency: 'USD',
};

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};

describe('Smart DOM burst benchmark', () => {
  it('handles 20 updates/ms bursts within the frame budget', () => {
    const rand = rng(42);
    const book = new OrderBook();
    const mid = 20_000;
    const bids: [number, number][] = [];
    const asks: [number, number][] = [];
    for (let i = 0; i < 400; i++) {
      bids.push([mid - 1 - i, 10 + Math.floor(rand() * 200)]);
      asks.push([mid + i, 10 + Math.floor(rand() * 200)]);
    }
    book.applySnapshot({ ts: 0, bids, asks });
    const trades: Trade[] = [];
    const t0 = Date.UTC(2026, 10, 11, 14);
    // One hour of history so session maps are realistic.
    let id = 0;
    for (let i = 0; i < 200_000; i++)
      trades.push({
        ts: t0 - 3_600_000 + i * 18,
        px: mid - 40 + Math.floor(rand() * 80),
        qty: 1 + Math.floor(rand() * 5),
        side: rand() < 0.5 ? 'buy' : 'sell',
        id: ++id,
      });

    const model = new DomModel({ volumeScope: 'session' });
    let tpl = BUILTIN_TEMPLATES.find((t) => t.id === 'dark-extended')!;
    for (const c of tpl.columns) tpl = toggleColumn(tpl, c.id as DomColumnId, true);
    const ladder = new DomLadder(headlessSurface());
    ladder.setTemplate(tpl);
    ladder.resize(1200, 900, 1);
    const orders: Order[] = [];
    const notes = new Map([[mid + 3, 'Level']]);

    const FRAMES = 900;
    const FRAME_MS = 16;
    const PER_MS = 20;
    let now = t0;
    let last = mid;
    const frameTimes: number[] = [];
    const drawTimes: number[] = [];
    let updates = 0;
    // Warm-up frame consumes the history.
    model.update(trades, book, now, orders);
    for (let f = 0; f < FRAMES; f++) {
      const start = performance.now();
      for (let ms = 0; ms < FRAME_MS; ms++) {
        now++;
        for (let u = 0; u < PER_MS; u++) {
          updates++;
          if (rand() < 0.25) {
            const side = rand() < 0.5 ? 'buy' : 'sell';
            last = side === 'buy' ? book.bestAsk : book.bestBid;
            trades.push({ ts: now, px: last, qty: 1 + Math.floor(rand() * 4), side, id: ++id });
          } else {
            const bidSide = rand() < 0.5;
            const off = Math.floor(rand() * 30);
            const px = bidSide ? book.bestBid - off : book.bestAsk + off;
            book.applyDelta({
              side: bidSide ? 'buy' : 'sell',
              px,
              qty: rand() < 0.05 ? 0 : 1 + Math.floor(rand() * 300),
            });
          }
        }
      }
      const d0 = performance.now();
      model.update(trades, book, now, orders);
      ladder.draw({
        book,
        model,
        instrument: inst,
        lastPx: last,
        orders,
        position: { instrumentId: inst.id, qty: 2, avgPx: mid, realized: 0 },
        pnlPerTick: 12.5,
        notes,
        now,
      });
      const end = performance.now();
      drawTimes.push(end - d0);
      frameTimes.push(end - start);
    }
    const mean = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
    const report = {
      frames: FRAMES,
      updatesPerFrame: updates / FRAMES,
      frameMeanMs: +mean.toFixed(3),
      frameP95Ms: +pct(frameTimes, 0.95).toFixed(3),
      frameMaxMs: +Math.max(...frameTimes).toFixed(3),
      modelPlusDrawP95Ms: +pct(drawTimes, 0.95).toFixed(3),
      rows: ladder.rows,
      columns: ladder.layout.length,
    };
    console.log('[smart-dom burst]', JSON.stringify(report));
    expect(report.updatesPerFrame).toBe(PER_MS * FRAME_MS);
    expect(report.columns).toBe(tpl.columns.length);
    // 60 fps budget is 16.7 ms; the DOM must use well under half of it at p95.
    expect(report.frameP95Ms).toBeLessThan(8);
  });
});
