import { describe, expect, it } from 'vitest';
import {
  BarSeries,
  specKey,
  specLabel,
  specUnavailableReason,
  TIMEFRAME_PRESETS,
  type Bar,
  type BarSpec,
  type SessionRules,
} from './aggregator';
import { MockFeed } from './mockFeed';
import type { Trade } from './types';

let seq = 0;
const t = (ts: number, px: number, qty = 1, side: Trade['side'] = 'buy'): Trade => ({
  ts,
  px,
  qty,
  side,
  id: seq++,
});
/** Prices at 1 ms apart, 1 lot buys. */
const prices = (...pxs: number[]) => pxs.map((px, i) => t(i, px));
const ohlc = (bars: Bar[]) => bars.map((b) => [b.o, b.h, b.l, b.c]);
const build = (spec: BarSpec, trades: Trade[]) => BarSeries.build(spec, trades).bars;

describe('range variants', () => {
  it('Range X closes exactly at the N-tick boundary', () => {
    expect(ohlc(build({ kind: 'rangex', ticks: 2 }, prices(10, 11, 12, 15, 14, 13)))).toEqual([
      [10, 12, 10, 12],
      [15, 15, 13, 13],
    ]);
    // a print beyond the boundary completes the bar at N ticks and opens the next bar
    const b = build({ kind: 'rangex', ticks: 2 }, prices(10, 13));
    expect(ohlc(b)).toEqual([
      [10, 12, 10, 12],
      [13, 13, 13, 13],
    ]);
    expect(b.map((x) => x.vol)).toEqual([1, 1]);
  });

  it('Range XV needs the volume filter before closing', () => {
    const b = build({ kind: 'rangexv', ticks: 2, vol: 3 }, prices(10, 12, 13, 11));
    expect(ohlc(b)).toEqual([
      [10, 13, 10, 13],
      [11, 11, 11, 11],
    ]);
    expect(b[0]!.closed).toBe(true);
  });

  it('Range Z opens each bar at the previous close (no gaps)', () => {
    expect(ohlc(build({ kind: 'rangez', ticks: 2 }, prices(10, 11, 13, 12)))).toEqual([
      [10, 11, 10, 11],
      [11, 13, 11, 12],
    ]);
  });

  it('Range US uses trend / reversal targets and the open offset', () => {
    const b = build(
      { kind: 'rangeus', trend: 2, reversal: 4, offset: 1 },
      prices(10, 11, 12, 13, 10, 8),
    );
    expect(ohlc(b)).toEqual([
      [10, 12, 10, 12],
      [11, 13, 11, 13],
      [12, 12, 8, 8],
    ]);
    expect(b.map((x) => x.dir)).toEqual([1, 1, -1]);
  });
});

describe('renko / reversal / order flow / cumulative trades', () => {
  it('Renko builds 2-box-reversal bricks with traded wicks', () => {
    const tr = prices(10, 11, 12, 13, 15, 9, 6);
    const b = build({ kind: 'renko', box: 2 }, tr);
    expect(ohlc(b)).toEqual([
      [10, 12, 10, 12],
      [12, 15, 12, 14],
      [12, 12, 9, 10],
      [10, 10, 6, 8],
      [8, 8, 6, 6],
    ]);
    expect(b.map((x) => x.vol)).toEqual([3, 2, 1, 1, 0]);
    expect(b.map((x) => x.dir)).toEqual([1, 1, -1, -1, -1]);
    const nw = build({ kind: 'renko', box: 2, wicks: false }, tr);
    expect(ohlc(nw)[1]).toEqual([12, 14, 12, 14]);
    expect(ohlc(nw)[2]).toEqual([12, 12, 10, 10]);
  });

  it('Reversal bars close on size or pull-back', () => {
    expect(
      ohlc(build({ kind: 'reversal', size: 4, rev: 2 }, prices(10, 12, 13, 11, 14, 15, 16, 18))),
    ).toEqual([
      [10, 13, 10, 11],
      [14, 18, 14, 18],
    ]);
  });

  it('Order Flow bars split on aggressor change', () => {
    const tr = [
      t(0, 10, 1, 'buy'),
      t(1, 10, 1, 'buy'),
      t(2, 9, 1, 'sell'),
      t(3, 9, 1, 'sell'),
      t(4, 10, 1, 'buy'),
      t(5, 10, 1, 'unknown'),
    ];
    const b = build({ kind: 'orderflow', n: 1 }, tr);
    expect(b.map((x) => x.vol)).toEqual([2, 2, 2]);
    expect(b.map((x) => x.delta)).toEqual([2, -2, 1]);
    const tr2 = [
      t(0, 10, 1, 'buy'),
      t(1, 10, 1, 'sell'),
      t(2, 10, 1, 'buy'),
      t(3, 10, 1, 'sell'),
      t(4, 10, 1, 'sell'),
    ];
    expect(build({ kind: 'orderflow', n: 2 }, tr2).map((x) => x.trades)).toEqual([4, 1]);
  });

  it('Cumulative Trades merges same-time same-side prints and filters by size', () => {
    const tr = [
      t(1, 10, 1, 'buy'),
      t(1, 11, 2, 'buy'),
      t(2, 10, 1, 'sell'),
      t(3, 12, 5, 'buy'),
      t(3, 12, 1, 'sell'),
    ];
    expect(build({ kind: 'cumtrades', min: 0, max: 0 }, tr).map((b) => b.vol)).toEqual([
      3, 1, 5, 1,
    ]);
    expect(build({ kind: 'cumtrades', min: 2, max: 0 }, tr).map((b) => b.vol)).toEqual([3, 5]);
    expect(build({ kind: 'cumtrades', min: 0, max: 2 }, tr).map((b) => b.vol)).toEqual([1, 1]);
  });
});

describe('derived chart types', () => {
  it('Heikin-Ashi transforms time bars', () => {
    const b = build({ kind: 'heikin', ms: 10 }, [t(0, 10), t(5, 12), t(10, 11), t(15, 13)]);
    expect(ohlc(b)).toEqual([
      [11, 12, 10, 11],
      [11, 13, 11, 12],
    ]);
    expect(b[0]!.vol).toBe(2);
  });

  it('Point & Figure builds X / O columns', () => {
    const b = build(
      { kind: 'pnf', box: 1, reversal: 3 },
      prices(10, 11, 12, 13, 11, 10, 9, 12, 13),
    );
    expect(b.map((x) => [x.dir, x.o, x.c])).toEqual([
      [1, 10, 13],
      [-1, 12, 9],
      [1, 10, 13],
    ]);
    expect(b.reduce((a, x) => a + x.vol, 0)).toBe(9);
  });

  it('Kagi segments with yang / yin thickness flips', () => {
    const b = build({ kind: 'kagi', rev: 2 }, prices(10, 13, 15, 12, 11, 14, 16, 17, 13, 10, 18));
    expect(b.map((x) => [x.o, x.c])).toEqual([
      [10, 15],
      [15, 11],
      [11, 17],
      [17, 10],
      [10, 18],
    ]);
    const d = b[3]!;
    expect([d.thick0, d.thick, d.flip]).toEqual([1, 0, 11]);
    const e = b[4]!;
    expect([e.thick0, e.thick, e.flip]).toEqual([0, 1, 17]);
    expect(Number.isNaN(b[1]!.flip)).toBe(true);
  });

  it('Line Break draws lines from period closes', () => {
    const tr = [10, 12, 13, 11, 9, 8, 14, 14].map((px, i) => t(i * 10, px));
    const b = build({ kind: 'linebreak', lines: 3, ms: 10 }, tr);
    expect(b.map((x) => [x.o, x.c])).toEqual([
      [10, 12],
      [12, 13],
      [12, 9],
      [9, 8],
      [9, 14],
      [14, 14],
    ]);
    expect(b.slice(0, 5).every((x) => x.closed)).toBe(true);
    expect(b[5]!.closed).toBe(false);
  });
});

describe('sessions and time at price', () => {
  it('skips trades outside the session and anchors daily bars to the session open', () => {
    const H = 3_600_000;
    const D = 24 * H;
    // session 22:00 → 20:00 next day (UTC); 20:00–22:00 is closed
    const rules: SessionRules = {
      id: 'test',
      inSession: (ts) => {
        const h = (ts % D) / H;
        return !(h >= 20 && h < 22);
      },
      sessionStart: (ts) => Math.floor((ts - 22 * H) / D) * D + 22 * H,
    };
    const tr = [t(D + 19 * H, 10), t(D + 21 * H, 99), t(D + 23 * H, 11), t(2 * D + 10 * H, 12)];
    const s = BarSeries.build({ kind: 'time', ms: D }, tr, rules);
    expect(s.bars.map((b) => [b.t, b.vol])).toEqual([
      [22 * H, 1],
      [D + 22 * H, 2],
    ]);
    expect(s.bars.some((b) => b.clusters.has(99))).toBe(false);
    // M1 bars only see in-session prints
    expect(BarSeries.build({ kind: 'time', ms: 60_000 }, tr, rules).bars).toHaveLength(3);
  });

  it('credits time at price to the previous print, capped at the bar end', () => {
    const s = BarSeries.build({ kind: 'time', ms: 60_000 }, [
      t(0, 10),
      t(10_000, 11),
      t(30_000, 10),
      t(70_000, 12),
      t(80_000, 12),
    ]);
    const [a, b] = s.bars;
    expect(a!.clusters.get(10)!.tap).toBe(40_000);
    expect(a!.clusters.get(11)!.tap).toBe(20_000);
    expect(b!.clusters.get(12)!.tap).toBe(10_000);
  });
});

describe('incremental equals full recompute', () => {
  const feed = new MockFeed('CLZ6', {
    seed: 11,
    historyHours: 1,
    depthMinutes: 1,
    now: 1_700_000_000_000,
  });
  const { trades } = feed.historySync();
  const snap = (bars: Bar[]) =>
    bars.map((b) => [
      b.t,
      b.o,
      b.h,
      b.l,
      b.c,
      b.vol,
      b.delta,
      b.trades,
      b.closed,
      b.dir ?? null,
      b.thick ?? null,
      [...b.clusters].map(([px, c]) => [px, c.bid, c.ask, c.trades, c.maxTrade, c.tap]),
    ]);
  const specs: BarSpec[] = TIMEFRAME_PRESETS.flatMap((r) => r.specs);

  it('covers every preset bar type', () => {
    expect(new Set(specs.map((s) => s.kind)).size).toBe(17);
  });

  for (const spec of specs) {
    it(`${specLabel(spec)} (${specKey(spec)})`, () => {
      const bulk = BarSeries.build(spec, trades);
      const inc = new BarSeries(spec);
      // random-ish chunk sizes, including single trades
      let i = 0;
      let k = 1;
      while (i < trades.length) {
        inc.addAll(trades.slice(i, i + k));
        i += k;
        k = (k * 7 + 3) % 53;
        if (k === 0) k = 1;
      }
      expect(bulk.bars.length).toBeGreaterThan(0);
      expect(snap(inc.bars)).toEqual(snap(bulk.bars));
      // the columnar path is identical too
      const col = new BarSeries(spec);
      col.addColumns({
        ts: Float64Array.from(trades, (x) => x.ts),
        px: Int32Array.from(trades, (x) => x.px),
        qty: Float64Array.from(trades, (x) => x.qty),
        side: Int8Array.from(trades, (x) => (x.side === 'buy' ? 1 : x.side === 'sell' ? -1 : 0)),
      });
      expect(snap(col.bars)).toEqual(snap(bulk.bars));
      if (spec.kind !== 'cumtrades') {
        const vol = trades.reduce((a, x) => a + x.qty, 0);
        expect(bulk.bars.reduce((a, b) => a + b.vol, 0)).toBeCloseTo(vol, 6);
      }
    });
  }
});

describe('feed capabilities', () => {
  it('disables types that need data the feed lacks', () => {
    const noSide = { aggressor: false, ticks: true, subSecond: true };
    expect(specUnavailableReason({ kind: 'delta', n: 500 }, noSide)).toMatch(/aggressor/);
    expect(specUnavailableReason({ kind: 'orderflow', n: 1 }, noSide)).toMatch(/aggressor/);
    expect(specUnavailableReason({ kind: 'renko', box: 2 }, noSide)).toBeNull();
    const barsOnly = { aggressor: true, ticks: false, subSecond: false };
    expect(specUnavailableReason({ kind: 'tick', n: 50 }, barsOnly)).toMatch(/tick/);
    expect(specUnavailableReason({ kind: 'time', ms: 5000 }, barsOnly)).toMatch(/tick/);
    expect(specUnavailableReason({ kind: 'time', ms: 60_000 }, barsOnly)).toBeNull();
  });
});
