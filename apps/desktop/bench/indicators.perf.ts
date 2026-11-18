/**
 * Indicator targets ("applying an indicator makes the app lag"):
 * - apply 10 indicators to a chart with 50,000 bars: main-thread cost (what freezes the UI) and
 *   the total compute cost in the indicator workers
 * - a live tick with 10 indicators: main-thread cost per tick and worker throughput (ticks/s)
 *
 * The app's real path is used: `IndicatorPool` + `RemoteRuntime` on the "main thread", `EngineHost`
 * on the "worker". `SimTransport` stands in for postMessage: it structured-clones every message
 * both ways (that clone is what postMessage costs the sender / receiver) and charges the clone to
 * the main thread, while `EngineHost.handle` is charged to the worker.
 */
import { describe, expect, it } from 'vitest';
import {
  EngineHost,
  IndicatorPool,
  type BarData,
  type EngineTransport,
  type FromEngine,
  type RemoteRuntime,
  type ToEngine,
} from '@htflow/indicator-sdk';
import { indicatorById } from '@htflow/indicators';
import type { Bar, Cluster } from '@htflow/market-data';
import { measure, quantile, record, rng } from './harness';

const BARS = 50_000;
/** 10 indicators a trader typically stacks, incl. footprint-based ones, VWAP and cumulative delta. */
const IDS = [
  'sma',
  'ema',
  'rsi',
  'macd',
  'bollinger',
  'vwap',
  'cumulative-delta',
  'stacked-imbalance',
  'cluster-statistic',
  'fvg',
];

/** 50k M1 bars, 8 prints per bar spread over several price levels (footprint clusters). */
function makeBars(n: number): Bar[] {
  const r = rng(3);
  const bars: Bar[] = [];
  let px = 100_000;
  const t0 = Date.UTC(2026, 0, 5);
  for (let i = 0; i < n; i++) {
    const t = t0 + i * 60_000;
    const o = px;
    const clusters = new Map<number, Cluster>();
    let h = o;
    let l = o;
    let buy = 0;
    let sell = 0;
    for (let k = 0; k < 8; k++) {
      px += Math.floor(r() * 7) - 3;
      const q = 1 + Math.floor(r() * 20);
      const isBuy = r() < 0.5;
      const c = clusters.get(px) ?? { bid: 0, ask: 0, trades: 0, maxTrade: 0 };
      if (isBuy) c.ask += q;
      else c.bid += q;
      c.trades++;
      c.maxTrade = Math.max(c.maxTrade, q);
      clusters.set(px, c);
      h = Math.max(h, px);
      l = Math.min(l, px);
      if (isBuy) buy += q;
      else sell += q;
    }
    bars.push({
      t,
      tEnd: t + 59_999,
      o,
      h,
      l,
      c: px,
      vol: buy + sell,
      buy,
      sell,
      delta: buy - sell,
      maxDelta: buy,
      minDelta: -sell,
      trades: 8,
      clusters,
      closed: i < n - 1,
    } as Bar);
  }
  return bars;
}

/** postMessage stand-in: clones both ways, queues delivery, times main thread (delivery) vs worker. */
class SimTransport implements EngineTransport {
  private fn: ((m: FromEngine) => void) | null = null;
  private q: ToEngine[] = [];
  private host = new EngineHost(indicatorById);
  constructor(private clock: { main: number; worker: number }) {}
  post(msg: ToEngine): void {
    // Sender-side cost: counted by the caller's synchronous timing.
    this.q.push(structuredClone(msg));
  }
  /** Runs the worker side, then delivers the replies to the main thread. */
  flush(): void {
    const replies: FromEngine[] = [];
    for (const m of this.q.splice(0)) {
      const t0 = performance.now();
      const r = this.host.handle(m);
      this.clock.worker += performance.now() - t0;
      if (r) replies.push(r);
    }
    // Worker garbage is collected in the worker's own heap in the app; collect it here before
    // timing the main thread so it is not charged to the main thread.
    gc();
    const t1 = performance.now();
    for (const r of replies) this.fn?.(structuredClone(r));
    this.clock.main += performance.now() - t1;
  }
  onMessage(fn: (m: FromEngine) => void): void {
    this.fn = fn;
  }
  terminate(): void {
    this.fn = null;
  }
}

const gc = (globalThis as { gc?: () => void }).gc ?? (() => {});

function setup() {
  const bars = makeBars(BARS);
  let version = 1;
  const data: BarData = {
    bars,
    get version() {
      return version;
    },
    tickSize: 1,
  };
  const clock = { main: 0, worker: 0 };
  const transports: SimTransport[] = [];
  const pool = new IndicatorPool(() => {
    const t = new SimTransport(clock);
    transports.push(t);
    return t;
  }, 2);
  const flush = () => transports.forEach((t) => t.flush());
  /** One live print into the last bar (BarSeries mutates the last bar in place). */
  const tick = (k: number) => {
    const b = bars[bars.length - 1]!;
    const px = b.c + (k % 3) - 1;
    const q = 1 + (k % 5);
    b.c = px;
    b.h = Math.max(b.h, px);
    b.l = Math.min(b.l, px);
    b.vol += q;
    if (k % 2) b.buy += q;
    else b.sell += q;
    b.delta = b.buy - b.sell;
    const c = b.clusters.get(px) ?? { bid: 0, ask: 0, trades: 0, maxTrade: 0 };
    if (k % 2) c.ask += q;
    else c.bid += q;
    c.trades++;
    b.clusters.set(px, c);
    b.trades++;
    version++;
  };
  return { bars, data, clock, pool, flush, tick };
}

describe('indicators', () => {
  it('apply 10 indicators on 50k bars, then live ticks', () => {
    const { data, clock, pool, flush, tick } = setup();
    // --- apply: create + first update per indicator (what adding them to a chart does).
    const applyMain: number[] = [];
    const applyWorker: number[] = [];
    let rts: RemoteRuntime[] = [];
    for (let run = 0; run < 3; run++) {
      for (const rt of rts) rt.dispose();
      clock.main = 0;
      clock.worker = 0;
      gc();
      const t0 = performance.now();
      rts = IDS.map((id) => pool.create(indicatorById(id)!, { type: id, inputs: {} }, () => {}));
      for (const rt of rts) rt.update(data);
      const mainSync = performance.now() - t0;
      flush();
      applyMain.push(mainSync + clock.main);
      applyWorker.push(clock.worker);
    }
    for (const rt of rts) expect(rt.count).toBe(BARS);
    record({
      group: 'Indicators',
      name: 'Apply 10 indicators to 50,000 bars — main thread (UI freeze)',
      target: 'applying indicators keeps the UI responsive',
      budget: 100,
      unit: 'ms',
      median: quantile(applyMain, 0.5),
      p95: quantile(applyMain, 0.95),
      runs: applyMain.length,
      notes: IDS.join(', '),
    });
    record({
      group: 'Indicators',
      name: 'Apply 10 indicators to 50,000 bars — compute in the workers (total)',
      target: 'indicators appear within a second',
      budget: 1000,
      unit: 'ms',
      median: quantile(applyWorker, 0.5),
      p95: quantile(applyWorker, 0.95),
      runs: applyWorker.length,
    });

    // --- live ticks: every tick updates all 10 indicators (one message each) and applies replies.
    const tickMain: number[] = [];
    const tickWorker: number[] = [];
    measure(
      (k) => {
        clock.main = 0;
        clock.worker = 0;
        tick(k);
        const t0 = performance.now();
        for (const rt of rts) rt.update(data);
        const sync = performance.now() - t0;
        flush();
        tickMain.push(sync + clock.main);
        tickWorker.push(clock.worker);
      },
      { warmup: 10, runs: 100 },
    );
    const main = tickMain.slice(10);
    const worker = tickWorker.slice(10);
    record({
      group: 'Indicators',
      name: 'Live tick with 10 indicators (50,000 bars) — main thread per tick',
      target: '50 ticks/s with 10 indicators at 60 fps',
      budget: 2,
      unit: 'ms',
      median: quantile(main, 0.5),
      p95: quantile(main, 0.95),
      runs: main.length,
    });
    const wMed = quantile(worker, 0.5);
    const wP95 = quantile(worker, 0.95);
    record({
      group: 'Indicators',
      name: 'Tick throughput with 10 indicators (50,000 bars, 2 workers)',
      target: '50 ticks/s with 10 indicators',
      budget: 50,
      unit: 'ticks/s',
      higherIsBetter: true,
      // Work is spread over 2 workers; throughput = 1 s / (worker time per tick / 2).
      median: 1000 / Math.max(1e-6, wMed / 2),
      p95: 1000 / Math.max(1e-6, wP95 / 2),
      runs: worker.length,
    });
    expect(quantile(main, 0.5)).toBeLessThan(12);
  });
});
