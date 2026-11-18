/**
 * Golden tests: for every registered indicator, the live path (one update per print — the last bar
 * recomputed on every tick, a new bar appended when it opens) ends with exactly the same outputs
 * as a full recompute over the final bars. Also checks the worker wire codecs round-trip.
 */
import { describe, expect, it } from 'vitest';
import {
  CloneTransport,
  IndicatorPool,
  IndicatorRuntime,
  SeriesOut,
  computeIndicator,
  packBars,
  packList,
  unpackBars,
  unpackList,
  type BarData,
  type RuntimeLike,
} from '@htflow/indicator-sdk';
import { BarSeries, type Trade } from '@htflow/market-data';
import { INDICATORS, indicatorById } from './index';

function trades(n: number, seed = 5): Trade[] {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  let px = 5000;
  const out: Trade[] = [];
  for (let i = 0; i < n; i++) {
    // Trending stretches and reversals so swing / zone / pivot logic is exercised.
    px += Math.round((rnd() - (Math.floor(i / 150) % 2 ? 0.42 : 0.58)) * 8);
    out.push({
      ts: 1_700_000_000_000 + i * 2000,
      px,
      qty: 1 + Math.floor(rnd() * rnd() * 40),
      side: rnd() > 0.5 ? 'buy' : 'sell',
      id: i,
    });
  }
  return out;
}

function snapshot(rt: RuntimeLike): string {
  const o: Record<string, unknown> = { count: rt.count, notice: rt.notice };
  for (const [k, v] of Object.entries(rt.outputs)) {
    if (v instanceof SeriesOut) {
      const n = rt.count;
      o[k] = [v.v, v.v2, v.v3, v.v4].map((a) =>
        Array.from(a.slice(0, a.length ? n : 0)).map((x) => (Number.isNaN(x) ? null : x)),
      );
      o[`${k}.t`] = Array.from(v.tone.slice(0, n));
    } else o[k] = JSON.stringify(v.items);
  }
  return JSON.stringify(o);
}

const tape = trades(1200);
const between = (a: number, b: number) => tape.filter((t) => t.ts >= a && t.ts <= b);

describe('incremental equals full recompute (every registered indicator)', () => {
  it.each(INDICATORS.map((d) => [d.id, d] as const))('%s', (_id, def) => {
    const series = new BarSeries({ kind: 'time', ms: 60_000 });
    const data: BarData = {
      get bars() {
        return series.bars;
      },
      get version() {
        return series.version;
      },
      tickSize: 1,
      tradesBetween: between,
    };
    const rt = new IndicatorRuntime(def);
    const kinds = new Set<string>();
    for (const t of tape) {
      series.add(t);
      kinds.add(rt.update(data));
    }
    expect(kinds.has('incremental')).toBe(true);
    const full = computeIndicator(def, series.bars, undefined, { tradesBetween: between });
    expect(snapshot(rt)).toBe(snapshot(full));
  });
});

describe('worker wire codecs', () => {
  it('bars round-trip exactly (clusters and optional fields)', () => {
    const s = BarSeries.build({ kind: 'time', ms: 60_000 }, tape);
    const bars = s.bars.map((b, i) => (i % 7 === 0 ? { ...b, dir: 1, flip: Number.NaN } : b));
    const back = unpackBars(structuredClone(packBars(bars, 3)));
    expect(back).toEqual(bars.slice(3));
    expect(Object.keys(back[4]!)).toEqual(Object.keys(bars[7]!));
  });

  it('list items round-trip with the same keys in the same order', () => {
    const items = [
      { bar: 1, value: 2.5, shape: 'circle', size: 0, tone: 1 },
      { bar: 2, to: -1, value: 7, label: 'POC', tone: 0 },
      { bar: 3, value: Number.NaN, shape: 'text', size: 3, text: '12', tone: 2, textPos: 'above' },
      { bar: 4, value: 1, shape: 'square', size: 2, text: undefined, tone: 0 },
    ];
    const back = unpackList(structuredClone(packList(items)));
    expect(JSON.stringify(back)).toBe(JSON.stringify(items));
    expect(back.map((x) => Object.keys(x as object))).toEqual(items.map((x) => Object.keys(x)));
    expect((back[2] as { value: number }).value).toBeNaN();
  });
});

describe('worker pool shares one bar packet per worker', () => {
  it('several indicators of one chart on one worker match the main-thread result', async () => {
    const t = new CloneTransport(indicatorById);
    const pool = new IndicatorPool(() => t, 1);
    const series = new BarSeries({ kind: 'time', ms: 60_000 });
    const data: BarData = {
      get bars() {
        return series.bars;
      },
      get version() {
        return series.version;
      },
      tickSize: 1,
    };
    const ids = ['sma', 'fvg', 'zigzag', 'cluster-statistic', 'vwap'];
    const rts = ids.map((id) =>
      pool.create(indicatorById(id)!, { type: id, inputs: {} }, () => {}),
    );
    for (let k = 0; k < tape.length; k++) {
      series.add(tape[k]!);
      // A history load first (all bars at once), then live ticks.
      if (k >= 600 && (k === 600 || k % 3 === 0)) for (const rt of rts) rt.update(data);
      if (k % 40 === 0) await t.idle();
    }
    for (const rt of rts) rt.update(data);
    for (let k = 0; k < 4; k++) await t.idle();
    ids.forEach((id, k) =>
      expect(snapshot(rts[k]!)).toBe(snapshot(computeIndicator(indicatorById(id)!, series.bars))),
    );
  });
});

/** True when an update changed a series value before the previous last bar. */
function revisesHistory(def: (typeof INDICATORS)[number], tape: Trade[]): boolean {
  const lb = (x: number) => {
    let lo = 0;
    let hi = tape.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (tape[m]!.ts < x) lo = m + 1;
      else hi = m;
    }
    return lo;
  };
  const between = (a: number, b: number) => tape.slice(lb(a), lb(b + 1));
  const series = new BarSeries({ kind: 'time', ms: 60_000 });
  const data: BarData = {
    get bars() {
      return series.bars;
    },
    get version() {
      return series.version;
    },
    tickSize: 1,
    tradesBetween: between,
  };
  const rt = new IndicatorRuntime(def);
  let prev = new Map<string, Float64Array[]>();
  for (const t of tape) {
    series.add(t);
    const stable = rt.count - 1;
    rt.update(data);
    for (const [k, o] of Object.entries(rt.outputs)) {
      if (!(o instanceof SeriesOut)) continue;
      const before = prev.get(k);
      const cur = [o.v, o.v2, o.v3, o.v4, Float64Array.from(o.tone)];
      if (before)
        for (let c = 0; c < 5; c++)
          for (let i = 0; i < Math.min(stable, before[c]!.length); i++) {
            const a = before[c]![i]!;
            const b = cur[c]![i]!;
            if (a !== b && !(Number.isNaN(a) && Number.isNaN(b))) return true;
          }
    }
    prev = new Map();
    for (const [k, o] of Object.entries(rt.outputs))
      if (o instanceof SeriesOut)
        prev.set(
          k,
          [o.v, o.v2, o.v3, o.v4, Float64Array.from(o.tone)].map((a) => a.slice(0, rt.count)),
        );
  }
  return false;
}

describe('stableHistory hint (lets the worker skip the history diff)', () => {
  it('every built-in marked stable never rewrites an earlier bar', () => {
    const long = trades(2500, 9).map((t, i) => ({ ...t, ts: 1_700_000_000_000 + i * 100_000 }));
    const stable = INDICATORS.filter((d) => d.stableHistory);
    expect(stable.length).toBeGreaterThan(150);
    expect(indicatorById('zigzag')!.stableHistory).toBeFalsy();
    const bad = stable.filter((d) => revisesHistory(d, tape) || revisesHistory(d, long));
    expect(bad.map((d) => d.id)).toEqual([]);
  }, 300_000);
});
