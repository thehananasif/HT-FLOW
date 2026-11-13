// @vitest-environment jsdom
/**
 * Time & Sales target (P16): 5,000 prints/sec stays smooth. One 60 fps frame of the Smart Tape
 * ingests 1/60 s of prints (TapeBuffer + speed meter, as the window's frame loop does) and redraws
 * the visible rows with the window's own draw function.
 */
import { describe, expect, it } from 'vitest';
import { MarketStore, findMockInstrument, type Trade } from '@htflow/market-data';
import { DEFAULT_FILTER, TapeBuffer } from '@htflow/tape';
import { installHeadlessDom, measure, record, rng } from './harness';

installHeadlessDom();

const tape = await import('../ui/src/modules/smart-tape/TapeView');

const FRAME_60 = 1000 / 60;
const inst = findMockInstrument('BTCUSDT')!.instrument;

function prints(n: number, t0: number, perSec: number, seed = 3): Trade[] {
  const r = rng(seed);
  let px = 9_000_000;
  return Array.from({ length: n }, (_, i) => {
    if (r() < 0.2) px += r() < 0.5 ? -1 : 1;
    return {
      ts: t0 + (i * 1000) / perSec,
      px,
      qty: 1 + Math.floor(r() * r() * 30),
      side: r() < 0.5 ? 'buy' : 'sell',
      id: i + 1,
    } satisfies Trade;
  });
}

describe('tape (headless frame cost)', () => {
  for (const rate of [5_000, 20_000]) {
    it(`Smart Tape at ${rate.toLocaleString('en')} prints/s`, () => {
      const store = new MarketStore(inst);
      const t0 = Date.UTC(2026, 10, 12, 14);
      const hist = prints(20_000, t0 - 20_000, 1000);
      store.loadHistory({
        trades: hist,
        depth: [],
        book: { ts: t0, bids: [[8_999_999, 5]], asks: [[9_000_000, 5]] },
        end: t0,
      });
      const e = tape.buildEngine(store, 'timestamp', 50, 65_536);
      tape.refreshBuckets(e, 0);
      const canvas = document.createElement('canvas');
      const live = prints(rate * 30, t0, rate, 9);
      const perFrame = Math.ceil(rate / 60);
      let at = 0;
      const m = measure(
        () => {
          for (let i = 0; i < perFrame; i++) {
            const tr = live[at++ % live.length]!;
            const created = e.buf.push(tr, 8_999_999, 9_000_000);
            e.speed.add(tr.ts, tr.qty, created ? 1 : 0);
          }
          tape.drawTape(canvas, 640, 900, e, {
            variant: 'smart',
            inst,
            filter: DEFAULT_FILTER,
            cols: tape.SMART_COLUMNS.map((c) => c.id),
            buckets: true,
            scroll: 0,
            paused: false,
            colorBySide: true,
          });
        },
        { warmup: 20, runs: 300 },
      );
      record({
        group: 'Time & Sales',
        name: `Smart Tape at ${rate.toLocaleString('en')} prints/s (${perFrame} prints + 45 visible rows per frame)`,
        target: '5,000 prints/s stays smooth (60 fps)',
        budget: FRAME_60,
        unit: 'ms/frame',
        ...m,
      });
      expect(m.median).toBeLessThan(FRAME_60 * 6);
    });
  }

  it('tape buffer ingest throughput', () => {
    const live = prints(600_000, 0, 5000, 4);
    const m = measure(
      () => {
        const b = new TapeBuffer(65_536, { mode: 'timestamp', windowMs: 0 });
        for (const tr of live) b.push(tr, 0, 0);
      },
      { warmup: 1, runs: 7 },
    );
    const perSec = (n: number) => (live.length / n) * 1000;
    record({
      group: 'Time & Sales',
      name: 'Tape buffer ingest (aggregation by timestamp, 600k prints)',
      target: '5,000 prints/s',
      budget: 5000,
      unit: 'prints/s',
      median: perSec(m.median),
      p95: perSec(m.p95),
      runs: m.runs,
      higherIsBetter: true,
    });
    expect(perSec(m.median)).toBeGreaterThan(50_000);
  });
});
