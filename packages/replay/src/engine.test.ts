import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BarSeries,
  findMockInstrument,
  MarketSimulator,
  MarketStore,
  MockFeed,
  OrderBook,
  TIMEFRAME_PRESETS,
  type Bar,
  type BarSpec,
  type EventBatch,
} from '@htflow/market-data';
import { datasetFromHistory, hashString, simulatedDataset } from './dataset';
import { ReplayEngine } from './engine';
import { ReplayGroup, ReplayScheduler } from './group';

const T0 = Date.UTC(2026, 10, 3, 0, 10, 0);
const MIN = 60_000;
const ds = (sym = 'CLZ6', mins = 12) => simulatedDataset(sym, T0, T0 + mins * MIN);

const barKey = (b: Bar) => [
  b.t,
  b.o,
  b.h,
  b.l,
  b.c,
  b.vol,
  b.delta,
  b.trades,
  [...b.clusters.entries()].map(([px, c]) => [px, c.bid, c.ask, c.trades]),
];

function storeFor(e: ReplayEngine): MarketStore {
  const s = new MarketStore(e.instrument);
  s.loadHistory(e.state());
  e.subscribe((b) => s.ingest(b));
  e.onReset(() => s.loadHistory(e.state()));
  return s;
}

const levels = (b: OrderBook) => ({
  bids: [...b.bids.entries()].sort((x, y) => x[0] - y[0]),
  asks: [...b.asks.entries()].sort((x, y) => x[0] - y[0]),
});

describe('ReplayEngine', () => {
  afterEach(() => vi.useRealTimers());

  it('simulated datasets are deterministic by seed and consistent across ranges of a day', () => {
    const a = ds();
    const b = ds();
    expect(a.trades.length).toBeGreaterThan(500);
    expect(a.deltas.length).toBeGreaterThan(1000);
    expect(b.trades).toEqual(a.trades);
    const later = simulatedDataset('CLZ6', T0 + 6 * MIN, T0 + 12 * MIN);
    expect(later.trades).toEqual(a.trades.filter((t) => t.ts > T0 + 6 * MIN));
    const other = simulatedDataset('CLZ6', T0, T0 + 12 * MIN, undefined, { seed: 99 });
    expect(other.trades).not.toEqual(a.trades);
  });

  it('mixed play / step / speed changes build the same bars and footprints as the raw trades', () => {
    const data = ds();
    const e = new ReplayEngine(data);
    const store = storeFor(e);
    const specs: BarSpec[] = TIMEFRAME_PRESETS.flatMap((r) => r.specs);
    for (const sp of specs) store.getSeries(sp);
    const seen: EventBatch[] = [];
    e.subscribe((b) => seen.push(b));
    e.play();
    e.setSpeed(5);
    for (let i = 0; i < 40; i++) e.tick(16);
    e.pause();
    for (let i = 0; i < 25; i++) e.stepTick();
    e.stepBar({ kind: 'time', ms: MIN });
    e.stepBar({ kind: 'tick', n: 50 });
    e.setSpeed(1000);
    e.play();
    for (let i = 0; i < 4; i++) e.tick(16);
    e.setSpeed(0.25);
    for (let i = 0; i < 10; i++) e.tick(16);
    e.setSpeed(100);
    while (e.playing) e.tick(16);
    expect(e.time).toBe(e.end);
    // Never drops or reorders an event.
    expect(seen.flatMap((b) => b.trades)).toEqual(data.trades);
    expect(seen.reduce((a, b) => a + b.deltas.length, 0)).toBe(data.deltas.length);
    for (let i = 1; i < seen.length; i++)
      expect(seen[i]!.ts).toBeGreaterThanOrEqual(seen[i - 1]!.ts);
    for (const sp of specs)
      expect(store.getSeries(sp).bars.map(barKey)).toEqual(
        BarSeries.build(sp, data.trades).bars.map(barKey),
      );
    // Final book equals the simulator's own book.
    const m = findMockInstrument('CLZ6')!;
    const day = Math.floor(T0 / 86_400_000);
    const sim = new MarketSimulator(
      { ...m.sim, seed: (hashString('CLZ6') ^ Math.imul(day, 0x9e3779b1)) >>> 0 },
      day * 86_400_000,
    );
    while (sim.t < data.end) sim.step(Math.min(250, data.end - sim.t), [], []);
    const ref = new OrderBook();
    ref.applySnapshot(sim.snapshot());
    expect(levels(store.book)).toEqual(levels(ref));
  });

  it('the store never holds anything after the replay clock (hide future bars)', () => {
    const e = new ReplayEngine(ds());
    const store = storeFor(e);
    e.play();
    e.setSpeed(50);
    for (let i = 0; i < 30; i++) {
      e.tick(16);
      expect(store.lastTrade ? store.lastTrade.ts : 0).toBeLessThanOrEqual(e.time);
      expect(store.lastTs).toBeLessThanOrEqual(e.time);
    }
    const bars = store.getSeries({ kind: 'time', ms: MIN }).bars;
    expect(bars[bars.length - 1]!.tEnd).toBeLessThanOrEqual(e.time);
    expect(store.trades.length).toBeLessThan(e.dataset.trades.length);
  });

  it('step tick emits exactly one trade; step bar / step back bar move by whole bars', () => {
    const data = ds();
    const e = new ReplayEngine(data);
    const store = storeFor(e);
    for (let i = 0; i < 7; i++) {
      const out = e.stepTick();
      expect(out.flatMap((b) => b.trades)).toEqual([data.trades[i]]);
      expect(e.time).toBe(data.trades[i]!.ts);
    }
    for (const spec of [
      { kind: 'time', ms: MIN },
      { kind: 'tick', n: 50 },
      { kind: 'volume', n: 100 },
      { kind: 'range', ticks: 4 },
    ] as BarSpec[]) {
      e.seek(e.start);
      const full = BarSeries.build(spec, data.trades);
      const series = store.getSeries(spec);
      for (let k = 1; k <= 4; k++) {
        e.stepBar(spec);
        expect(series.bars.length).toBe(k);
        expect(barKey(series.bars[k - 1]!)).toEqual(barKey(full.bars[k - 1]!));
      }
      e.stepTick();
      expect(series.bars.length).toBe(5);
      e.stepBar(spec); // completes the partial bar
      expect(barKey(series.bars[4]!)).toEqual(barKey(full.bars[4]!));
      e.stepBackBar(spec);
      expect(series.bars.map(barKey)).toEqual(full.bars.slice(0, 4).map(barKey));
      e.stepBackBar(spec);
      expect(series.bars.length).toBe(3);
    }
  });

  it('jump to time rebuilds the same book, trades and depth as playing there', () => {
    const data = ds();
    const target = T0 + 7 * MIN + 1234;
    const played = new ReplayEngine(data);
    const a = storeFor(played);
    played.advanceTo(target);
    const jumped = new ReplayEngine(data);
    const b = storeFor(jumped);
    jumped.advanceTo(data.end);
    jumped.seek(target);
    expect(jumped.time).toBe(target);
    expect(b.trades).toEqual(a.trades);
    expect(levels(b.book)).toEqual(levels(a.book));
    expect(b.book.bestBid).toBe(a.book.bestBid);
    expect(b.depth.length).toBeGreaterThan(1000);
    expect(Math.abs(b.depth.length - a.depth.length)).toBeLessThanOrEqual(2);
    const last = b.depth[b.depth.length - 1]!;
    expect(target - last.t).toBeLessThan(250);
    // Continuing after a jump ends in the same state as an uninterrupted run.
    jumped.advanceTo(data.end);
    played.advanceTo(data.end);
    expect(b.trades).toEqual(a.trades);
    expect(levels(b.book)).toEqual(levels(a.book));
  });

  it('speed is a scheduler multiplier; ticks are capped and coalesced into 250 ms batches', () => {
    const e = new ReplayEngine(ds());
    e.play();
    e.tick(16);
    expect(e.time - e.start).toBeCloseTo(16, 6);
    e.setSpeed(0.25);
    e.tick(16);
    expect(e.time - e.start).toBeCloseTo(20, 6);
    e.seek(e.start);
    e.setSpeed(1000);
    const out = e.tick(16);
    expect(e.time - e.start).toBeCloseTo(16_000, 6);
    expect(out.length).toBeGreaterThan(50);
    expect(out.length).toBeLessThanOrEqual(65);
    for (const b of out) for (const t of b.trades) expect(b.ts - t.ts).toBeLessThanOrEqual(250);
    e.seek(e.start);
    e.tick(5000); // stalled tab: capped at 100 ms of wall time
    expect(e.time - e.start).toBeCloseTo(100_000, 6);
    expect(() => e.setSpeed(0)).toThrow();
  });

  it('loops a range, stops at the end and keeps bookmarks sorted', () => {
    const e = new ReplayEngine(ds());
    let resets = 0;
    e.onReset(() => resets++);
    e.setLoop({ from: T0 + MIN, to: T0 + 2 * MIN });
    e.seek(T0 + MIN);
    e.setSpeed(100);
    e.play();
    for (let i = 0; i < 10; i++) e.tick(100);
    expect(resets).toBeGreaterThanOrEqual(2);
    expect(e.time).toBeGreaterThanOrEqual(T0 + MIN);
    expect(e.time).toBeLessThanOrEqual(T0 + 2 * MIN);
    e.setLoop(null);
    e.setSpeed(1000);
    while (e.playing) e.tick(100);
    expect(e.time).toBe(e.end);
    e.addBookmark(T0 + 5 * MIN, 'b');
    const a = e.addBookmark(T0 + 2 * MIN, 'a');
    expect(e.bookmarks.map((b) => b.label)).toEqual(['a', 'b']);
    e.removeBookmark(a.id);
    expect(e.bookmarks).toHaveLength(1);
  });

  it('replays MarketStore history (depth columns as snapshots) and trade-only data', () => {
    const feed = new MockFeed('ESZ6', { historyHours: 0.2, depthMinutes: 6, now: T0 });
    const live = new MarketStore(feed.instrument);
    live.loadHistory(feed.historySync());
    const from = T0 - 5 * MIN;
    const data = datasetFromHistory(live, from, T0);
    expect(data.snapshots.length).toBeGreaterThan(1000);
    expect(data.initialBook).toBeDefined();
    const e = new ReplayEngine(data);
    const store = storeFor(e);
    e.setSpeed(1000);
    e.play();
    while (e.playing) e.tick(16);
    expect(store.trades).toEqual(live.tradesBetween(from, T0));
    expect(levels(store.book)).toEqual(levels(e.bookAt(T0)));
    expect(store.depth.length).toBeGreaterThan(1000); // every snapshot reached the heatmap
    expect(store.book.bestBid).toBe(live.depth[live.depth.length - 1]!.bestBid);
    // Ticks only: a one-level book follows the tape.
    const ticks = new ReplayEngine(
      datasetFromHistory(live, from, T0, { ticks: true, depth: false }),
    );
    const s2 = storeFor(ticks);
    ticks.advanceTo(from + MIN);
    expect(s2.book.bestAsk - s2.book.bestBid).toBe(1);
    expect(Math.abs(s2.lastTrade!.px - s2.book.bestBid)).toBeLessThanOrEqual(1);
  });

  it('a synced group keeps instruments on one clock; the scheduler drives it', () => {
    vi.useFakeTimers();
    const a = new ReplayEngine(ds('CLZ6', 6));
    const b = new ReplayEngine(ds('ESZ6', 6));
    const c = new ReplayEngine(ds('NQZ6', 6));
    const g = new ReplayGroup([a, b, c]);
    let now = 0;
    const sch = new ReplayScheduler(g, 16, () => now);
    g.setSpeed(100);
    g.play();
    sch.start();
    for (let i = 0; i < 50; i++) {
      now += 16;
      vi.advanceTimersByTime(16);
      expect(g.inSync()).toBe(true);
    }
    expect(a.time - a.start).toBeCloseTo(50 * 16 * 100, 3);
    g.pause();
    g.stepTick(b);
    expect(g.inSync()).toBe(true);
    g.stepBar({ kind: 'time', ms: MIN }, c);
    g.stepBackBar({ kind: 'time', ms: MIN }, a);
    g.seek(T0 + 3 * MIN);
    expect(g.inSync()).toBe(true);
    g.sync = false;
    g.stepTick(a);
    expect(g.inSync()).toBe(false);
    sch.stop();
    expect(sch.running).toBe(false);
  });
});
