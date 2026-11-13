/**
 * Data-path targets: 10,000+ symbol search < 50 ms (P04), DOM update latency < 16 ms from socket
 * to pixel (HARD CONSTRAINTS 4, P15 "20 updates / ms burst") and tick aggregation (P07).
 */
import { describe, expect, it } from 'vitest';
import { SearchIndex, type SearchDoc } from '@htflow/market-catalog';
import { BarSeries, OrderBook, type Instrument, type Trade } from '@htflow/market-data';
import {
  BUILTIN_TEMPLATES,
  DomLadder,
  DomModel,
  toggleColumn,
  type DomColumnId,
} from '@htflow/dom';
import { headlessContext, measure, quantile, record, rng } from './harness';

describe('instrument search', () => {
  it('10,000 instruments, typical and typo queries', () => {
    const words = ['alpha', 'beta', 'gamma', 'delta', 'omega', 'nova', 'terra', 'solar', 'quant'];
    const venues = ['NYSE', 'NASDAQ', 'BINANCE', 'OKX', 'EUREX', 'CME'];
    const r = rng(11);
    const used = new Set<string>();
    const docs: SearchDoc[] = [];
    for (let k = 0; docs.length < 10_000; k++) {
      let sym = '';
      for (let c = 0; c < 3 + (k % 3); c++) sym += String.fromCharCode(65 + Math.floor(r() * 26));
      if (used.has(sym)) continue;
      used.add(sym);
      docs.push({
        id: `gen:${k}`,
        symbol: sym,
        root: sym,
        name: `${words[k % 9]} ${words[(k * 7) % 9]} holdings ${k}`,
        exchange: venues[k % venues.length]!,
      });
    }
    const idx = new SearchIndex(docs);
    const queries = [
      'a',
      'ab',
      'nee',
      'gamma holdings',
      'nyse',
      'binance omega',
      'quantt',
      'zzzzzz',
    ];
    const m = measure((k) => idx.search(queries[k % queries.length]!), { warmup: 8, runs: 160 });
    record({
      group: 'Search',
      name: `Instrument search over ${docs.length.toLocaleString('en')} symbols (8 query shapes incl. typos)`,
      target: '10,000+ symbol search < 50 ms',
      budget: 50,
      unit: 'ms',
      ...m,
    });
    expect(m.median).toBeLessThan(250);
  });
});

describe('Smart DOM', () => {
  it('20 updates / ms burst: socket batch to drawn ladder', () => {
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
    const rand = rng(42);
    const book = new OrderBook();
    const mid = 20_000;
    const lv = (sign: number) =>
      Array.from(
        { length: 400 },
        (_, i) =>
          [mid + sign * i - (sign < 0 ? 1 : 0), 10 + Math.floor(rand() * 200)] as [number, number],
      );
    book.applySnapshot({ ts: 0, bids: lv(-1), asks: lv(1) });
    const t0 = Date.UTC(2026, 10, 11, 14);
    const trades: Trade[] = [];
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
    const ctx = headlessContext();
    const ladder = new DomLadder({ width: 0, height: 0, getContext: () => ctx });
    ladder.setTemplate(tpl);
    ladder.resize(1200, 900, 1);
    let now = t0;
    let last = mid;
    model.update(trades, book, now, []);
    const m = measure(
      () => {
        // One 16 ms frame worth of socket messages (320 book deltas + trades), then the frame.
        for (let u = 0; u < 320; u++) {
          if (u % 20 === 0) now++;
          if (rand() < 0.25) {
            const side = rand() < 0.5 ? 'buy' : 'sell';
            last = side === 'buy' ? book.bestAsk : book.bestBid;
            trades.push({ ts: now, px: last, qty: 1 + Math.floor(rand() * 4), side, id: ++id });
          } else {
            const bid = rand() < 0.5;
            const off = Math.floor(rand() * 30);
            book.applyDelta({
              side: bid ? 'buy' : 'sell',
              px: bid ? book.bestBid - off : book.bestAsk + off,
              qty: rand() < 0.05 ? 0 : 1 + Math.floor(rand() * 300),
            });
          }
        }
        model.update(trades, book, now, []);
        ladder.draw({
          book,
          model,
          instrument: inst,
          lastPx: last,
          orders: [],
          position: { instrumentId: inst.id, qty: 2, avgPx: mid, realized: 0 },
          pnlPerTick: 12.5,
          notes: new Map(),
          now,
        });
      },
      { warmup: 30, runs: 600 },
    );
    record({
      group: 'Smart DOM',
      name: 'Burst of 320 updates (20 / ms) → model update → full ladder draw, every column on',
      target: 'DOM update latency < 16 ms socket to pixel',
      budget: 16,
      unit: 'ms',
      ...m,
    });
    expect(m.median).toBeLessThan(16 * 6);
  });
});

describe('aggregation', () => {
  it('1M ticks into M1 cluster bars', () => {
    const N = 1_000_000;
    const r = rng(5);
    const ts = new Float64Array(N);
    const px = new Int32Array(N);
    const qty = new Float64Array(N);
    const side = new Int8Array(N);
    let p = 100_000;
    for (let i = 0; i < N; i++) {
      const u = r();
      if (u < 0.2) p--;
      else if (u > 0.8) p++;
      ts[i] = 1.7e12 + i * 300;
      px[i] = p;
      qty[i] = 1 + Math.floor(r() * 8);
      side[i] = u < 0.5 ? -1 : 1;
    }
    const times: number[] = [];
    for (let k = 0; k < 5; k++) {
      const s = new BarSeries({ kind: 'time', ms: 60_000 });
      const t0 = performance.now();
      s.addColumns({ ts, px, qty, side });
      times.push(performance.now() - t0);
    }
    record({
      group: 'Aggregation',
      name: '1M ticks → M1 cluster bars (columnar path, used when a chart loads history)',
      target: 'charts open with 1M+ ticks (P07: 10M ticks < 1 s)',
      budget: 100,
      unit: 'ms',
      median: quantile(times, 0.5),
      p95: quantile(times, 0.95),
      runs: times.length,
    });
    expect(quantile(times, 0.5)).toBeLessThan(1500);
  });
});
