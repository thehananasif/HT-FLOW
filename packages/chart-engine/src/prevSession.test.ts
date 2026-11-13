import { describe, expect, it } from 'vitest';
import type { Bar, BarSeries } from '@htflow/market-data';
import { PrevSessionProfileLayer, prevSessionRange } from './layers/prevSession';

const H = 3_600_000;
const D = 86_400_000;

function bar(t: number, levels: [number, number][] = [[100, 1]]): Bar {
  const clusters = new Map(levels.map(([px, v]) => [px, { bid: v / 2, ask: v / 2, trades: 1 }]));
  return {
    t,
    tEnd: t,
    o: 100,
    h: 100,
    l: 100,
    c: 100,
    vol: 1,
    buy: 0,
    sell: 0,
    delta: 0,
    maxDelta: 0,
    minDelta: 0,
    trades: 1,
    clusters,
    closed: true,
  } as unknown as Bar;
}

describe('previous-session profile', () => {
  it('finds the session before the last bar', () => {
    const bars = [bar(D - 2 * H), bar(D - H), bar(D + H), bar(D + 2 * H)];
    expect(prevSessionRange(bars)).toEqual({ from: 0, to: 1, start: 0 });
    // A custom session start (offset) moves the boundary.
    expect(prevSessionRange(bars, -3 * H)).toBeNull();
  });

  it('returns null without an earlier session', () => {
    expect(prevSessionRange([bar(D + H), bar(D + 2 * H)])).toBeNull();
    expect(prevSessionRange([])).toBeNull();
  });

  it('builds POC and value area of that session only', () => {
    const bars = [
      bar(D - 3 * H, [
        [100, 10],
        [101, 2],
      ]),
      bar(D - 2 * H, [
        [100, 5],
        [99, 1],
      ]),
      bar(D + H, [[200, 1000]]),
    ];
    const series = { bars, version: 1 } as unknown as BarSeries;
    const layer = new PrevSessionProfileLayer(() => series);
    const r = layer.profile()!;
    expect(r.start).toBe(0);
    expect(r.prof.poc).toBe(100);
    expect(r.prof.total).toBe(18);
    expect(r.prof.val).toBeLessThanOrEqual(100);
    expect(r.prof.vah).toBeGreaterThanOrEqual(100);
  });
});
