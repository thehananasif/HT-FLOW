import { describe, expect, it } from 'vitest';
import { aggregateBars, defaultInputs } from '@htflow/indicator-sdk';
import { BarSeries, type Trade } from '@htflow/market-data';
import { CATALOG, INDICATORS, indicatorById } from './index';
import { N, run, vals } from './testkit';

function trades(n: number): Trade[] {
  let s = 11;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  let px = 500;
  const out: Trade[] = [];
  for (let i = 0; i < n; i++) {
    px += Math.round((rnd() - 0.5) * 6);
    out.push({
      ts: 1_700_000_000_000 + i * 4000,
      px,
      qty: 1 + Math.floor(rnd() * 20),
      side: rnd() > 0.5 ? 'buy' : 'sell',
      id: i,
    });
  }
  return out;
}

describe('higher-timeframe series', () => {
  const tr = trades(3000);
  const m1 = new BarSeries({ kind: 'time', ms: 60_000 });
  const m5 = new BarSeries({ kind: 'time', ms: 300_000 });
  m1.addAll(tr);
  m5.addAll(tr);
  it('chart bars merged per period equal a BarSeries of that timeframe built from the same trades', () => {
    const agg = aggregateBars(m1.bars, 'M5');
    expect(agg.length).toBe(m5.bars.length);
    agg.forEach((a, k) => {
      const b = m5.bars[k]!;
      expect([a.t, a.o, a.h, a.l, a.c]).toEqual([b.t, b.o, b.h, b.l, b.c]);
      expect(a.vol).toBeCloseTo(b.vol, 9);
      expect(a.buy).toBeCloseTo(b.buy, 9);
      expect(a.sell).toBeCloseTo(b.sell, 9);
      expect(a.delta).toBeCloseTo(b.delta, 9);
      expect(a.trades).toBe(b.trades);
      expect(a.maxDelta).toBeCloseTo(b.maxDelta, 9);
      expect(a.minDelta).toBeCloseTo(b.minDelta, 9);
      expect(a.clusters.size).toBe(b.clusters.size);
      for (const [px, c] of b.clusters) {
        const x = a.clusters.get(px)!;
        expect([x.bid, x.ask, x.trades, x.maxTrade]).toEqual([c.bid, c.ask, c.trades, c.maxTrade]);
      }
    });
  });

  it('MTF SMA / RSI / VWAP map the higher-timeframe values onto chart bars', () => {
    const agg = aggregateBars(m1.bars, 'M5');
    for (const [id, out, base, inputs] of [
      ['mtf-sma', 'ma', 'sma', { period: 3 }],
      ['mtf-rsi', 'rsi', 'rsi', { period: 4 }],
      ['mtf-atr', 'atr', 'atr', { period: 3 }],
      ['mtf-vwap', 'vwap', 'vwap', { reset: 'never' }],
    ] as const) {
      const ref = vals(run(base, agg, inputs), out);
      const closed = vals(
        run(id, m1.bars, { ...inputs, mtfTimeframe: 'M5', mtfMode: 'closed' }),
        out,
      );
      const live = vals(run(id, m1.bars, { ...inputs, mtfTimeframe: 'M5', mtfMode: 'live' }), out);
      let j = -1;
      let t = N;
      m1.bars.forEach((b, i) => {
        const p = Math.floor(b.t / 300_000) * 300_000;
        if (p !== t) {
          j++;
          t = p;
        }
        const last =
          m1.bars[i + 1] === undefined || Math.floor(m1.bars[i + 1]!.t / 300_000) * 300_000 !== p;
        const prev = j > 0 ? ref[j - 1]! : N;
        if (Number.isNaN(prev)) expect(closed[i], `${id} closed ${i}`).toBeNaN();
        else expect(closed[i], `${id} closed ${i}`).toBeCloseTo(prev, 9);
        // when the chart bar is the last one of its period, the forming bar is the full bar
        if (last) {
          if (Number.isNaN(ref[j]!)) expect(live[i]).toBeNaN();
          else expect(live[i], `${id} live ${i}`).toBeCloseTo(ref[j]!, 9);
        }
      });
    }
  });

  it('MTF indicators are catalogued with a timeframe input and mirror the base outputs', () => {
    const mtf = INDICATORS.filter((d) => d.id.startsWith('mtf-'));
    expect(mtf).toHaveLength(14);
    for (const d of mtf) {
      const base = indicatorById(d.id.slice(4))!;
      expect(Object.keys(d.outputs), d.id).toEqual(Object.keys(base.outputs));
      expect(d.inputs.mtfTimeframe?.type).toBe('timeframe');
      expect(defaultInputs(d.inputs).mtfMode).toBe('closed');
      expect(CATALOG.some((e) => e.impl === d.id)).toBe(true);
    }
  });

  it('validates the timeframe input (invalid → default, "chart" not allowed)', () => {
    const rt = run('mtf-sma', m1.bars.slice(0, 20), { mtfTimeframe: 'chart', period: 0 });
    expect(rt.inputs.mtfTimeframe).toBe('H1');
    expect(rt.inputs.period).toBe(1);
  });
});
