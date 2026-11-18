import { describe, expect, it } from 'vitest';
import {
  CloneTransport,
  IndicatorPool,
  LocalTransport,
  SAMPLE_SCRIPT,
  SeriesOut,
  computeIndicator,
  mtfOf,
  scriptIndicator,
  type AnyIndicator,
  type BarData,
  type EngineSpec,
  type RuntimeLike,
} from '@htflow/indicator-sdk';
import { BarSeries, type Trade } from '@htflow/market-data';
import { INDICATORS, indicatorById, poolable } from './index';

function randomTrades(n: number, seed = 11): Trade[] {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  let px = 1000;
  const out: Trade[] = [];
  for (let i = 0; i < n; i++) {
    px += Math.round((rnd() - 0.5) * 6);
    out.push({
      ts: 1_700_000_000_000 + i * 1500,
      px,
      qty: 1 + Math.floor(rnd() * 30),
      side: rnd() > 0.5 ? 'buy' : 'sell',
      id: i,
    });
  }
  return out;
}

function snapshot(rt: RuntimeLike): string {
  const o: Record<string, unknown> = { count: rt.count };
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

const trades = randomTrades(900);

async function viaPool(def: AnyIndicator, spec: EngineSpec, transports: CloneTransport[]) {
  const pool = new IndicatorPool((k) => transports[k]!, transports.length);
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
  const rt = pool.create(def, spec, () => {});
  const kinds = new Set<string>();
  for (let k = 0; k < trades.length; k++) {
    series.add(trades[k]!);
    if (k % 5 === 0 || k === trades.length - 1) kinds.add(rt.update(data));
    // One message in flight per runtime (backpressure): let the worker answer now and then so
    // the incremental path is exercised; updates in between coalesce.
    if (k % 50 === 0) await Promise.all(transports.map((t) => t.idle()));
  }
  await Promise.all(transports.map((t) => t.idle()));
  return { rt, series, kinds };
}

describe('indicator worker pool (Stage 8)', () => {
  const defs = INDICATORS.filter(poolable);

  it('routes tape / feed indicators to the main thread', () => {
    expect(poolable(indicatorById('big-trades')!)).toBe(false);
    expect(poolable(indicatorById('funding-rate')!)).toBe(false);
    expect(poolable(indicatorById('ema')!)).toBe(true);
    expect(defs.length).toBeGreaterThan(150);
  });

  it.each(defs.map((d) => [d.id, d] as const))(
    '%s: pooled (structured clone, incremental) == main-thread full',
    async (_id, def) => {
      const transports = [new CloneTransport(indicatorById), new CloneTransport(indicatorById)];
      const { rt, series, kinds } = await viaPool(def, { type: def.id, inputs: {} }, transports);
      expect(kinds.has('incremental')).toBe(true);
      expect(snapshot(rt)).toBe(snapshot(computeIndicator(def, series.bars)));
    },
  );

  it('timeframe override (MTF) runs in the pool and equals the wrapper on the main thread', async () => {
    const base = indicatorById('rsi')!;
    const spec: EngineSpec = {
      type: 'rsi',
      inputs: { period: 5 },
      mtf: { tf: 'M5', mode: 'live' },
    };
    const { rt, series } = await viaPool(mtfOf(base), spec, [new CloneTransport(indicatorById)]);
    const full = computeIndicator(mtfOf(base), series.bars, {
      period: 5,
      mtfTimeframe: 'M5',
      mtfMode: 'live',
    });
    expect(snapshot(rt)).toBe(snapshot(full));
  });

  it('user scripts are compiled inside the host and match the main thread', async () => {
    const def = scriptIndicator('script:sample', SAMPLE_SCRIPT);
    const spec: EngineSpec = {
      type: 'script:sample',
      inputs: { length: 7 },
      script: { source: SAMPLE_SCRIPT, name: 'Sample' },
    };
    const { rt, series } = await viaPool(def, spec, [new CloneTransport(indicatorById)]);
    expect(rt.count).toBe(series.bars.length);
    expect(snapshot(rt)).toBe(snapshot(computeIndicator(def, series.bars, { length: 7 })));
  });

  it('LocalTransport (main-thread fallback) answers synchronously', () => {
    const pool = new IndicatorPool(() => new LocalTransport(indicatorById), 1);
    const series = new BarSeries({ kind: 'time', ms: 60_000 });
    for (const t of trades.slice(0, 300)) series.add(t);
    const def = indicatorById('ema')!;
    const rt = pool.create(def, { type: 'ema', inputs: {} }, () => {});
    rt.update({ bars: series.bars, version: series.version, tickSize: 1 });
    expect(rt.pending).toBe(0);
    expect(snapshot(rt)).toBe(snapshot(computeIndicator(def, series.bars)));
  });

  it('reports unknown indicators and script errors as notices', () => {
    const pool = new IndicatorPool(() => new LocalTransport(indicatorById), 1);
    const def = scriptIndicator('script:x', 'plot("a", close)');
    const rt = pool.create(
      def,
      { type: 'script:x', inputs: {}, script: { source: 'plot("a", fetch(1))', name: 'x' } },
      () => {},
    );
    rt.update({ bars: [], version: 1, tickSize: 1 });
    expect(rt.notice).toMatch(/Unknown function 'fetch'/);
  });
});
