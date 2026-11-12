import { describe, expect, it } from 'vitest';
import {
  DerivativesLog,
  IndicatorRuntime,
  SeriesOut,
  computeIndicator,
  type AnyIndicator,
} from '@htflow/indicator-sdk';
import { BarSeries, type Bar, type DepthColumn, type Trade } from '@htflow/market-data';
import { CATALOG, INDICATORS, catalogCounts, indicatorById, isImplemented } from './index';

/** Bars from closes (o = previous close, h/l = ±1 around the body, simple clusters). */
function mkBars(
  closes: number[],
  opts: { vol?: number[]; delta?: number[]; t0?: number; ms?: number } = {},
): Bar[] {
  return closes.map((c, i) => {
    const o = i > 0 ? closes[i - 1]! : c;
    const vol = opts.vol?.[i] ?? 10;
    const delta = opts.delta?.[i] ?? (c >= o ? 2 : -2);
    const buy = (vol + delta) / 2;
    const sell = (vol - delta) / 2;
    return {
      t: (opts.t0 ?? 0) + i * (opts.ms ?? 60_000),
      tEnd: (opts.t0 ?? 0) + i * (opts.ms ?? 60_000) + 59_000,
      o,
      h: Math.max(o, c) + 1,
      l: Math.min(o, c) - 1,
      c,
      vol,
      buy,
      sell,
      delta,
      maxDelta: Math.max(0, delta) + 1,
      minDelta: Math.min(0, delta) - 1,
      trades: 5,
      clusters: new Map([[c, { bid: sell, ask: buy, trades: 5, maxTrade: 3 }]]),
      closed: true,
    };
  });
}

const run = (id: string, bars: Bar[], inputs?: Record<string, number | string | boolean>) =>
  computeIndicator(indicatorById(id)!, bars, inputs);
const vals = (rt: IndicatorRuntime, out: string) =>
  Array.from((rt.outputs[out] as SeriesOut).v.slice(0, rt.count));
const close = (a: number[], b: number[], eps = 1e-9) => {
  expect(a.length).toBe(b.length);
  a.forEach((x, k) => {
    if (Number.isNaN(b[k]!)) expect(x).toBeNaN();
    else expect(x).toBeCloseTo(b[k]!, Math.round(-Math.log10(eps)));
  });
};
const N = Number.NaN;

describe('moving averages', () => {
  const bars = mkBars([1, 2, 3, 4, 5, 6]);
  it('SMA / WMA / EMA reference values', () => {
    close(vals(run('sma', bars, { period: 3 }), 'ma'), [N, N, 2, 3, 4, 5]);
    // WMA 3: (1·1 + 2·2 + 3·3)/6 = 14/6
    close(vals(run('wma', bars, { period: 3 }), 'ma'), [N, N, 14 / 6, 20 / 6, 26 / 6, 32 / 6]);
    // EMA 3: seed SMA(1,2,3)=2, α=0.5 → 3, 4, 5
    close(vals(run('ema', bars, { period: 3 }), 'ma'), [N, N, 2, 3, 4, 5]);
    // SMMA 3: seed 2, α=1/3 → 2 + (4−2)/3
    const s = vals(run('smma', bars, { period: 3 }), 'ma');
    expect(s[3]).toBeCloseTo(2 + 2 / 3);
  });
  it('DEMA/TEMA equal the input on a straight line once warm', () => {
    const line = mkBars(Array.from({ length: 40 }, (_, i) => 100 + 2 * i));
    expect(vals(run('dema', line, { period: 5 }), 'ma')[39]).toBeCloseTo(178, 6);
    expect(vals(run('tema', line, { period: 5 }), 'ma')[39]).toBeCloseTo(178, 6);
    expect(vals(run('lsma', line, { period: 5 }), 'ma')[39]).toBeCloseTo(178, 6);
    expect(vals(run('hma', line, { period: 9 }), 'ma')[39]).toBeCloseTo(178, 6);
  });
  it('VWMA weights by volume', () => {
    const b = mkBars([10, 20], { vol: [1, 3] });
    expect(vals(run('vwma', b, { period: 2 }), 'ma')[1]).toBeCloseTo((10 + 60) / 4);
  });
  it('MA of delta uses the delta source', () => {
    const b = mkBars([1, 2, 3], { delta: [4, 6, 8] });
    close(vals(run('sma', b, { period: 2, source: 'delta' }), 'ma'), [N, 5, 7]);
    // CVD = 4, 10, 18
    close(vals(run('sma', b, { period: 2, source: 'cvd' }), 'ma'), [N, 7, 14]);
  });
});

describe('bands and volatility', () => {
  it('Bollinger uses population σ', () => {
    const rt = run('bollinger', mkBars([2, 4, 4, 4, 5, 5, 7, 9]), { period: 8, mult: 2 });
    // mean 5, σ 2
    expect(vals(rt, 'basis')[7]).toBeCloseTo(5);
    expect(vals(rt, 'upper')[7]).toBeCloseTo(9);
    expect(vals(rt, 'lower')[7]).toBeCloseTo(1);
    expect(
      vals(run('bb-percent-b', mkBars([2, 4, 4, 4, 5, 5, 7, 9]), { period: 8 }), 'pb')[7],
    ).toBeCloseTo(1);
    expect(
      vals(run('bb-bandwidth', mkBars([2, 4, 4, 4, 5, 5, 7, 9]), { period: 8 }), 'bw')[7],
    ).toBeCloseTo(160);
    expect(
      vals(run('stdev', mkBars([2, 4, 4, 4, 5, 5, 7, 9]), { period: 8 }), 'sd')[7],
    ).toBeCloseTo(2);
  });
  it('ATR is Wilder smoothing of the true range', () => {
    // Constant closes: every bar h−l = 2 → ATR 2.
    const rt = run('atr', mkBars([5, 5, 5, 5, 5]), { period: 3 });
    close(vals(rt, 'atr'), [N, N, 2, 2, 2]);
  });
  it('Donchian takes highest high / lowest low', () => {
    const rt = run('donchian', mkBars([5, 8, 3, 6]), { period: 3 });
    // highs: 6, 9, 9, 7 ; lows: 4, 4, 2, 2
    expect(vals(rt, 'upper')[2]).toBe(9);
    expect(vals(rt, 'lower')[3]).toBe(2);
    expect(vals(rt, 'mid')[3]).toBe((9 + 2) / 2);
  });
  it('Keltner basis is an EMA and bands are ATR multiples', () => {
    const rt = run('keltner', mkBars([5, 5, 5, 5]), { period: 2, atrPeriod: 2, mult: 1 });
    expect(vals(rt, 'basis')[3]).toBe(5);
    expect(vals(rt, 'upper')[3]).toBe(7);
  });
});

describe('oscillators', () => {
  it('RSI: all gains → 100, all losses → 0, Wilder reference', () => {
    expect(vals(run('rsi', mkBars([1, 2, 3, 4, 5]), { period: 2 }), 'rsi')[4]).toBe(100);
    expect(vals(run('rsi', mkBars([5, 4, 3, 2, 1]), { period: 2 }), 'rsi')[4]).toBe(0);
    // closes 1,3,2,4 period 2: gains [_,2,0,2] losses [_,0,1,0]
    // seed at i=2: AG=1, AL=0.5 → RSI 66.67; i=3: AG=1.5, AL=0.25 → 85.71
    close(vals(run('rsi', mkBars([1, 3, 2, 4]), { period: 2 }), 'rsi'), [N, N, 200 / 3, 600 / 7]);
  });
  it('Stochastic %K raw and smoothing', () => {
    // Closes 1..5, period 3, no smoothing: H = c+1, L = prev−1 → at i=4: HH=6, LL=2 → 75
    const rt = run('stochastic', mkBars([1, 2, 3, 4, 5]), { k: 3, smooth: 1, d: 1 });
    expect(vals(rt, 'k')[4]).toBeCloseTo(80); // HH = 6, LL = 1 (bar 2 low)
  });
  it('Williams %R mirrors stochastic', () => {
    expect(vals(run('williams-r', mkBars([1, 2, 3, 4, 5]), { period: 3 }), 'r')[4]).toBeCloseTo(
      -20,
    );
  });
  it('MACD = EMA(fast) − EMA(slow); histogram = MACD − signal', () => {
    const bars = mkBars(Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 4) * 10));
    const rt = run('macd', bars, { fast: 3, slow: 6, signal: 3 });
    const f = vals(run('ema', bars, { period: 3 }), 'ma');
    const s = vals(run('ema', bars, { period: 6 }), 'ma');
    const m = vals(rt, 'macd');
    expect(m[30]).toBeCloseTo(f[30]! - s[30]!);
    expect(vals(rt, 'hist')[30]).toBeCloseTo(m[30]! - vals(rt, 'signal')[30]!);
  });
  it('CCI, ROC, Momentum, CMO, Z-score, BOP', () => {
    // CCI: hlc3 of mkBars([1,2,3]) = c (h/l symmetric) → TP 1,2,3; mean 2; MD 2/3 → (3−2)/(0.015·2/3)=100
    expect(vals(run('cci', mkBars([1, 2, 3]), { period: 3 }), 'cci')[2]).toBeCloseTo(100);
    expect(vals(run('roc', mkBars([100, 110]), { period: 1 }), 'roc')[1]).toBeCloseTo(10);
    expect(vals(run('momentum', mkBars([100, 110, 130]), { period: 2 }), 'mom')[2]).toBe(30);
    expect(vals(run('cmo', mkBars([1, 2, 1, 3]), { period: 3 }), 'cmo')[3]).toBeCloseTo(
      (100 * (3 - 1)) / 4,
    );
    expect(
      vals(run('zscore', mkBars([2, 4, 4, 4, 5, 5, 7, 9]), { period: 8 }), 'z')[7],
    ).toBeCloseTo(2);
    // BOP: bar (o=1,c=3,h=4,l=0) → 0.5
    expect(vals(run('bop', mkBars([1, 3]), { period: 1 }), 'bop')[1]).toBeCloseTo(0.5);
  });
  it('Stoch RSI and TRIX produce bounded / finite output', () => {
    const bars = mkBars(Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 3) * 5 + i * 0.1));
    const k = vals(run('stoch-rsi', bars), 'k').filter((x) => !Number.isNaN(x));
    expect(k.length).toBeGreaterThan(30);
    k.forEach((x) => {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(100);
    });
    expect(Number.isFinite(vals(run('trix', bars, { period: 5 }), 'trix')[79]!)).toBe(true);
  });
});

describe('trend', () => {
  it('ADX: steady up-trend → DI+ dominant, ADX → 100', () => {
    const rt = run('adx', mkBars(Array.from({ length: 60 }, (_, i) => i * 3)), {
      period: 5,
      smooth: 5,
    });
    expect(vals(rt, 'minus')[59]).toBe(0);
    expect(vals(rt, 'adx')[59]).toBeCloseTo(100);
  });
  it('Aroon up = 100 on a fresh high', () => {
    const rt = run('aroon', mkBars([1, 2, 3, 4, 5, 6]), { period: 3 });
    expect(vals(rt, 'up')[5]).toBe(100);
    expect(vals(rt, 'down')[5]).toBe(0);
  });
  it('Parabolic SAR stays below price in an up-trend', () => {
    const bars = mkBars(Array.from({ length: 30 }, (_, i) => 10 + i));
    const rt = run('psar', bars);
    for (let i = 2; i < 30; i++) expect(vals(rt, 'sar')[i]!).toBeLessThan(bars[i]!.l);
    // i=1: SAR = min(lows) = 9; i=2: 9 + 0.02·(12 − 9)
    expect(vals(rt, 'sar')[2]).toBeCloseTo(Math.min(9 + 0.02 * 3, bars[0]!.l, bars[1]!.l));
  });
  it('SuperTrend flips to the down line after a crash', () => {
    const closes = [
      ...Array.from({ length: 20 }, (_, i) => 100 + i),
      ...Array.from({ length: 10 }, (_, i) => 80 - i * 3),
    ];
    const rt = run('supertrend', mkBars(closes), { period: 3, mult: 1 });
    expect(Number.isNaN(vals(rt, 'up')[15]!)).toBe(false);
    expect(Number.isNaN(vals(rt, 'down')[29]!)).toBe(false);
  });
  it('Ichimoku Tenkan is the 9-bar midpoint', () => {
    const bars = mkBars(Array.from({ length: 60 }, (_, i) => i));
    const rt = run('ichimoku', bars);
    // highs i+1, lows (i−1)−1 → at 59: HH=60, LL=50−1−1 → (60 + 49)/2
    expect(vals(rt, 'tenkan')[59]).toBeCloseTo((60 + (51 - 1 - 1)) / 2);
  });
  it('ZigZag connects confirmed swings', () => {
    const closes = [100, 110, 120, 110, 100, 105, 115];
    const rt = run('zigzag', mkBars(closes), { deviation: 5 });
    const z = vals(rt, 'zz');
    expect(z[2]).toBe(121); // swing high (bar high)
    expect(z[4]).toBe(99); // swing low
  });
  it('Heikin-Ashi close = OHLC4', () => {
    const bars = mkBars([10, 12]);
    const rt = run('heikin-ashi', bars);
    const s = rt.outputs.ha as SeriesOut;
    expect(s.v4[1]).toBeCloseTo((10 + 13 + 9 + 12) / 4);
    expect(s.v[1]).toBeCloseTo((s.v[0]! + s.v4[0]!) / 2);
  });
});

describe('volume-based', () => {
  const bars = mkBars([10, 12, 11, 11], { vol: [5, 10, 20, 7] });
  it('OBV, PVT, A/D, CMF, MFI, Force', () => {
    close(vals(run('obv', bars), 'obv'), [0, 10, -10, -10]);
    expect(vals(run('pvt', bars), 'pvt')[1]).toBeCloseTo((10 * 2) / 10);
    // A/D bar1: h=13 l=9 c=12 → MFM 0.5 → 5
    expect(vals(run('ad-line', bars), 'ad')[1]).toBeCloseTo(
      vals(run('ad-line', bars), 'ad')[0]! + 5,
    );
    expect(vals(run('cmf', bars, { period: 1 }), 'cmf')[1]).toBeCloseTo(0.5);
    expect(vals(run('mfi', mkBars([1, 2, 3, 4]), { period: 2 }), 'mfi')[3]).toBe(100);
    expect(vals(run('force-index', bars, { period: 1 }), 'fi')[1]).toBe(20);
  });
});

describe('levels', () => {
  const day = 86_400_000;
  // Two days of 3 bars each.
  const bars = mkBars([10, 14, 12, 20, 22, 21], { ms: day / 3 });
  it('classic pivots from previous day H/L/C', () => {
    const rt = run('pivot-points', bars);
    // Day 1: H = 15, L = 9, C = 12 → P = 12
    expect(vals(rt, 'p')[3]).toBeCloseTo(12);
    expect(vals(rt, 'r1')[3]).toBeCloseTo(15);
    expect(vals(rt, 's1')[3]).toBeCloseTo(9);
    expect(vals(rt, 'p')[1]).toBeNaN();
  });
  it('previous session OHLC', () => {
    const rt = run('prev-session-ohlc', bars);
    expect(vals(rt, 'o')[4]).toBe(10);
    expect(vals(rt, 'h')[4]).toBe(15);
    expect(vals(rt, 'l')[4]).toBe(9);
    expect(vals(rt, 'c')[4]).toBe(12);
  });
});

describe('order flow', () => {
  it('Volume, Delta (wicks), Bid Ask, Average Delta, Bid Ask VR', () => {
    const bars = mkBars([1, 2, 1], { vol: [10, 20, 30], delta: [2, 4, -6] });
    close(vals(run('volume', bars), 'vol'), [10, 20, 30]);
    const d = run('delta', bars);
    close(vals(d, 'delta'), [2, 4, -6]);
    expect((d.outputs.delta as SeriesOut).v2[1]).toBe(5);
    expect((d.outputs.delta as SeriesOut).tone[2]).toBe(1);
    close(vals(run('bid-ask', bars), 'ask'), [6, 12, 12]);
    close(vals(run('bid-ask', bars), 'bid'), [-4, -8, -18]);
    close(vals(run('average-delta', bars, { period: 2, type: 'sma' }), 'avg'), [N, 3, -1]);
    expect(vals(run('bid-ask-vr', bars, { period: 1 }), 'vr')[0]).toBeCloseTo(6 / 4);
  });
  it('Cumulative delta resets each session', () => {
    const day = 86_400_000;
    const bars = mkBars([1, 2, 3, 4], { delta: [1, 2, 3, 4], ms: day / 2 });
    close(vals(run('cumulative-delta', bars, { mode: 'line' }), 'line'), [1, 3, 3, 7]);
    close(
      vals(run('cumulative-delta', bars, { mode: 'line', reset: 'never' }), 'line'),
      [1, 3, 6, 10],
    );
    const c = run('cumulative-delta', bars).outputs.candles as SeriesOut;
    expect(c.v[1]).toBe(1); // open = previous CVD
    expect(c.v4[1]).toBe(3);
  });
  it('VWAP from clusters with σ bands', () => {
    const b = mkBars([10, 20], { vol: [1, 1] });
    const rt = run('vwap', b, { bands: 1 });
    expect(vals(rt, 'vwap')[1]).toBeCloseTo(15);
    expect(vals(rt, 'u1')[1]).toBeCloseTo(20);
    expect(vals(rt, 'l1')[1]).toBeCloseTo(10);
  });
  it('Big Trades aggregates same-side prints inside the window', () => {
    const bars = mkBars([100]);
    const trades: Trade[] = [
      { ts: 1000, px: 100, qty: 15, side: 'buy', id: 1 },
      { ts: 1020, px: 101, qty: 10, side: 'buy', id: 2 },
      { ts: 1500, px: 100, qty: 30, side: 'sell', id: 3 },
      { ts: 1600, px: 100, qty: 5, side: 'sell', id: 4 },
    ];
    const rt = computeIndicator(
      indicatorById('big-trades')!,
      bars,
      { min: 20, window: 50 },
      { tradesBetween: () => trades },
    );
    const items = rt.list('bubbles')!.items as { value: number; tone: number }[];
    expect(items.length).toBe(2);
    expect(items[0]!.value).toBeCloseTo((15 * 100 + 10 * 101) / 25);
    expect(items[1]!.tone).toBe(1);
  });
  it('Stacked imbalance finds 3 stacked buy levels', () => {
    const [b] = mkBars([100]);
    b!.clusters = new Map([
      [99, { bid: 5, ask: 1, trades: 1, maxTrade: 1 }],
      [100, { bid: 2, ask: 20, trades: 1, maxTrade: 1 }],
      [101, { bid: 2, ask: 10, trades: 1, maxTrade: 1 }],
      [102, { bid: 1, ask: 9, trades: 1, maxTrade: 1 }],
    ]);
    const zones = run('stacked-imbalance', [b!]).list('zones')!.items as {
      top: number;
      bottom: number;
      tone: number;
    }[];
    expect(zones).toEqual([expect.objectContaining({ bottom: 99.5, top: 102.5, tone: 0 })]);
  });
  it('Dynamic levels: developing POC / VA and Maximum Levels', () => {
    const bars = mkBars([100, 101, 101], { vol: [10, 30, 5] });
    const rt = run('dynamic-levels', bars);
    expect(vals(rt, 'poc')[0]).toBe(100);
    expect(vals(rt, 'poc')[2]).toBe(101);
    expect(vals(run('maximum-levels', bars), 'vol')[2]).toBe(101);
  });
  it('Speed of tape spikes, daily change, psychological levels, candle stats, market power, rhythm', () => {
    const bars = mkBars([1, 1, 1, 1], { vol: [1, 1, 1, 9] });
    expect(
      (run('speed-of-tape', bars, { metric: 'volume', period: 2, k: 2 }).outputs.speed as SeriesOut)
        .tone[3],
    ).toBe(1);
    const day = 86_400_000;
    const dc = run('daily-change', mkBars([100, 110], { ms: day }));
    expect((dc.list('label')!.items[0] as { text: string }).text).toBe('+10.00%');
    const psy = computeIndicator(
      indicatorById('psychological-levels')!,
      mkBars([1234]),
      { step: 1, count: 1 },
      { tickSize: 0.01 },
    );
    expect(psy.list('levels')!.items.map((l) => (l as { value: number }).value)).toEqual([
      1100, 1200, 1300,
    ]);
    expect(run('candle-statistics', bars).list('labels')!.items.length).toBe(4);
    expect(
      vals(
        run('market-power', mkBars([1, 3], { delta: [0, 5] }), { period: 1, type: 'sma' }),
        'mp',
      )[1],
    ).toBe(10);
    expect(vals(run('order-flow-rhythm', bars), 'tps')[0]).toBeCloseTo(5 / 60);
  });
});

/** Random trades → BarSeries; incremental updates (trade by trade) must equal a full recompute. */
function randomTrades(n: number, seed = 7): Trade[] {
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

function snapshot(rt: IndicatorRuntime): string {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rt.outputs)) {
    if (v instanceof SeriesOut) {
      const n = rt.count;
      o[k] = [v.v, v.v2, v.v3, v.v4].map((a) =>
        Array.from(a.slice(0, a.length ? n : 0)).map((x) =>
          Number.isNaN(x) ? null : +x.toFixed(9),
        ),
      );
      o[k + '.t'] = Array.from(v.tone.slice(0, n));
    } else o[k] = JSON.stringify(v.items);
  }
  return JSON.stringify(o);
}

/** Simulated derivatives + depth feeds aligned with the trades; `upTo(ts)` releases events with time <= ts. */
function makeFeeds(trades: Trade[]) {
  const t0 = trades[0]!.ts;
  const t1 = trades[trades.length - 1]!.ts;
  const log = new DerivativesLog();
  const depth = { version: 0, columns: [] as DepthColumn[] };
  const px = (t: number) => {
    let lo = 0;
    let hi = trades.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (trades[mid]!.ts <= t) lo = mid;
      else hi = mid - 1;
    }
    return trades[lo]!.px;
  };
  type Ev = { ts: number; run: () => void };
  const evs: Ev[] = [];
  let n = 0;
  for (let t = t0; t <= t1; t += 600_000)
    evs.push({
      ts: t,
      run: () =>
        log.addFunding({ kind: 'funding', ts: t, rate: ((n++ % 5) - 2) * 0.0001, nextTs: t + 600_000, markPrice: px(t) }),
    });
  let oi = 1_000_000;
  for (let t = t0 + 1000, k = 0; t <= t1; t += 20_000, k++) {
    oi += ((k * 37) % 11 - 5) * 1000;
    const v = oi;
    evs.push({ ts: t, run: () => log.addOpenInterest({ kind: 'open_interest', ts: t, oi: v, value: v * 1000 }) });
  }
  for (let t = t0 + 5000, k = 0; t <= t1; t += 97_000, k++)
    evs.push({
      ts: t,
      run: () =>
        log.addLiquidations([{ kind: 'liquidation', ts: t, side: k % 2 ? 'buy' : 'sell', px: px(t) + (k % 3), qty: 5 + (k % 7) * 20 }]),
    });
  for (let t = t0; t <= t1; t += 1000) {
    const p = px(t);
    evs.push({
      ts: t,
      run: () => {
        const pxs: number[] = [];
        const qs: number[] = [];
        for (let d = 0; d < 8; d++) {
          pxs.push(p - d);
          qs.push(1 + ((t / 1000 + d * 13) % 9) * (d === 3 ? 30 : 4));
          pxs.push(p + 1 + d);
          qs.push(1 + ((t / 1000 + d * 7) % 5) * (d === 4 ? 30 : 4));
        }
        depth.columns.push({ t, bestBid: p, bestAsk: p + 1, pxs: Int32Array.from(pxs), qtys: Float32Array.from(qs) });
        depth.version++;
      },
    });
  }
  evs.sort((a, b) => a.ts - b.ts);
  let at = 0;
  return {
    log,
    depth,
    upTo(ts: number) {
      while (at < evs.length && evs[at]!.ts <= ts) evs[at++]!.run();
    },
  };
}

describe('incremental contract', () => {
  const trades = randomTrades(1600);
  const cases: [string, AnyIndicator, Record<string, string | number | boolean> | undefined][] = [];
  for (const d of INDICATORS) {
    cases.push([d.id, d, undefined]);
    if (d.id.startsWith('mtf-')) {
      cases.push([d.id + ' M5 live', d, { mtfTimeframe: 'M5', mtfMode: 'live' }]);
      cases.push([d.id + ' M5 closed', d, { mtfTimeframe: 'M5', mtfMode: 'closed' }]);
    }
  }
  it.each(cases)('%s: incremental == full', (_id, def, inputs) => {
    const series = new BarSeries({ kind: 'time', ms: 60_000 });
    const between = (from: number, to: number) => trades.filter((t) => t.ts >= from && t.ts <= to);
    const feeds = makeFeeds(trades);
    const data = {
      get bars() {
        return series.bars;
      },
      get version() {
        return series.version;
      },
      tickSize: 1,
      tradesBetween: between,
      derivatives: feeds.log,
      depth: feeds.depth,
    };
    const inc = new IndicatorRuntime(def, inputs);
    for (let k = 0; k < trades.length; k++) {
      series.add(trades[k]!);
      feeds.upTo(trades[k]!.ts);
      if (k % 7 === 0 || k === trades.length - 1) inc.update(data);
    }
    const full = computeIndicator(def, series.bars, inputs, {
      tradesBetween: between,
      derivatives: feeds.log,
      depth: feeds.depth,
    });
    expect(inc.stats.full).toBe(1);
    expect(snapshot(inc)).toBe(snapshot(full));
  });
});

describe('catalog', () => {
  it('matches Appendix B counts', () => {
    expect(catalogCounts()).toEqual({
      'volume-orderflow': 36,
      'order-book': 6,
      options: 4,
      cot: 4,
      technical: 222,
      crypto: 3,
      trading: 3,
      samples: 2,
      custom: 1,
    });
  });
  it('every implementation reference resolves and every indicator is catalogued', () => {
    for (const e of CATALOG) if (e.impl) expect(indicatorById(e.impl), e.name).toBeDefined();
    for (const d of INDICATORS)
      expect(
        CATALOG.some((e) => e.impl === d.id),
        d.id,
      ).toBe(true);
    expect(new Set(CATALOG.map((e) => e.key)).size).toBe(CATALOG.length);
    expect(INDICATORS.length).toBeGreaterThanOrEqual(55);
    expect(CATALOG.filter(isImplemented).length).toBeGreaterThan(100);
  });
});
