import { describe, expect, it } from 'vitest';
import { DerivativesLog } from '@htflow/indicator-sdk';
import type { Bar, DepthColumn } from '@htflow/market-data';
import { N, between, items, mkBars, mkTrades, ohlcBars, run, vals } from './testkit';

const DAY = 86_400_000;
const close = (a: number[], b: number[], d = 6) => {
  expect(a.length).toBe(b.length);
  a.forEach((x, k) => {
    if (Number.isNaN(b[k]!)) expect(x).toBeNaN();
    else expect(x).toBeCloseTo(b[k]!, d);
  });
};
type M = { bar: number; value: number; tone: number; text?: string };
type Z = { bar: number; to: number; top: number; bottom: number; tone: number };

describe('moving averages (batch 2)', () => {
  it('ALMA: symmetric window on a line returns the centre value', () => {
    // n=3, offset .85 → m=1, σ-width 0.5: weights e^-2, 1, e^-2 → (w·1 + 2 + w·3)/(1 + 2w) = 2
    close(vals(run('alma', mkBars([1, 2, 3]), { period: 3 }), 'ma'), [N, N, 2]);
  });
  it('KAMA: ER = 1 on a straight line → sc = (2/3)²', () => {
    const v = vals(run('kama', mkBars([1, 2, 3]), { period: 2, fast: 2, slow: 30 }), 'ma');
    expect(v[2]).toBeCloseTo(2 + 4 / 9, 9);
  });
  it('McGinley: MD = 100 + 10/(1·2·1.1⁴)', () => {
    const v = vals(run('mcginley', mkBars([100, 110]), { period: 2, k: 1 }), 'ma');
    expect(v[1]).toBeCloseTo(100 + 10 / (2 * 1.1 ** 4), 9);
  });
  it('BWMA keeps only the centre of a 3-bar Blackman window; Block MA steps', () => {
    expect(
      vals(run('block-ma', mkBars([1, 5, 9]), { mode: 'bwma', period: 3 }), 'ma')[2],
    ).toBeCloseTo(5, 9);
    close(
      vals(run('block-ma', mkBars([1, 2, 3, 4, 5, 6, 7]), { mode: 'block', period: 3 }), 'ma'),
      [N, N, N, 2, 2, 2, 5],
    );
  });
  it('smoothers keep constants constant (T3, Jurik, VIDYA, FRAMA)', () => {
    const b = mkBars(Array(60).fill(7));
    for (const id of ['t3', 'jurik', 'vidya', 'frama']) {
      const v = vals(run(id, b), 'ma');
      expect(v[59], id).toBeCloseTo(7, 6);
    }
  });
  it('Jurik tracks a step upwards without overshooting at phase 0', () => {
    const b = mkBars([...Array(20).fill(10), ...Array(40).fill(20)]);
    const v = vals(run('jurik', b, { period: 5 }), 'ma');
    expect(v[59]).toBeGreaterThan(19.5);
    expect(Math.max(...v)).toBeLessThan(21);
  });
  it('FRAMA is bounded by price on a trend', () => {
    const b = mkBars(Array.from({ length: 50 }, (_, i) => 100 + i));
    const v = vals(run('frama', b, { period: 16 }), 'ma');
    expect(v[49]).toBeLessThanOrEqual(149);
    expect(v[49]).toBeGreaterThan(120);
  });
  it('MA Ribbon lines are SMAs with growing periods', () => {
    const b = mkBars([1, 2, 3, 4, 5, 6, 7, 8]);
    const rb = run('ma-ribbon', b, { type: 'sma', start: 2, step: 1, count: 3 });
    close(vals(rb, 'r1'), vals(run('sma', b, { period: 2 }), 'ma'));
    close(vals(rb, 'r3'), vals(run('sma', b, { period: 4 }), 'ma'));
    expect(vals(rb, 'r4').every(Number.isNaN)).toBe(true);
  });
  it('MA Cross marks the up cross', () => {
    const rt = run('ma-cross', mkBars([5, 4, 3, 2, 1, 2, 3, 4, 5, 6]), {
      type: 'sma',
      fast: 2,
      slow: 3,
    });
    const m = items<M>(rt, 'cross');
    expect(m.map((x) => [x.bar, x.tone])).toEqual([[6, 0]]);
  });
  it('Guppy has 12 EMAs', () => {
    const rt = run('guppy', mkBars(Array.from({ length: 80 }, (_, i) => i)));
    expect(vals(rt, 's1')[79]).toBeGreaterThan(vals(rt, 'l6')[79]!);
    expect(Object.keys(rt.outputs).length).toBe(12);
  });
});

describe('bands and channels (batch 2)', () => {
  const flat = mkBars([5, 5, 5, 5, 5, 5]);
  it('Squeeze: zero deviation is always inside the Keltner channel', () => {
    const rt = run('bb-squeeze', flat, { period: 3 });
    const s = rt.outputs.sqz as unknown as { tone: Uint8Array };
    expect(Array.from(s.tone.slice(2, 6))).toEqual([1, 1, 1, 1]);
    expect(vals(rt, 'mom')[5]).toBeCloseTo(0, 9);
    const v3 = run('bb-squeeze', flat, { period: 3, version: 'v3' });
    expect((v3.outputs.sqz as unknown as { tone: Uint8Array }).tone[5]).toBe(2);
  });
  it('Starc and ATR bands: constant TR = 2', () => {
    expect(vals(run('starc', flat, { period: 2, atr: 2, mult: 2 }), 'upper')[5]).toBe(9);
    expect(vals(run('starc', flat, { period: 2, atr: 2, mult: 2 }), 'lower')[5]).toBe(1);
    expect(vals(run('atr-bands', flat, { period: 2, mult: 3 }), 'upper')[5]).toBe(11);
  });
  it('linear regression on y = 2x + 1', () => {
    const b = mkBars([1, 3, 5, 7, 9]);
    expect(vals(run('linreg-slope', b, { period: 5 }), 'v')[4]).toBeCloseTo(2, 9);
    expect(vals(run('linreg-intercept', b, { period: 5 }), 'v')[4]).toBeCloseTo(1, 9);
    expect(vals(run('linreg-r2', b, { period: 5 }), 'v')[4]).toBeCloseTo(1, 9);
    const ch = run('linreg-channel', b, { period: 5, mult: 2 });
    expect(vals(ch, 'mid')[4]).toBeCloseTo(9, 9);
    expect(vals(ch, 'upper')[4]).toBeCloseTo(9, 9);
    expect(vals(run('stderr-bands', b, { period: 5 }), 'lower')[4]).toBeCloseTo(9, 9);
  });
  it('regression channel width = k·σ of the residuals', () => {
    // y = 0,2,2,0 → line y=1 (slope 0) → residuals ±1 → σ = 1
    const ch = run('linreg-channel', mkBars([0, 2, 2, 0]), { period: 4, mult: 2 });
    expect(vals(ch, 'upper')[3]).toBeCloseTo(1 + 2 * Math.sqrt(1.0), 6);
    // SE = √(Σe²/(n−2)) = √(4/2)
    const se = run('stderr-bands', mkBars([0, 2, 2, 0]), { period: 4, mult: 1 });
    expect(vals(se, 'upper')[3]! - vals(se, 'mid')[3]!).toBeCloseTo(Math.sqrt(2), 6);
  });
});

describe('trend (batch 2)', () => {
  const up = mkBars([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  it('DX = 100 when only +DM exists; ADXR / DMI follow', () => {
    expect(vals(run('dx', up, { period: 3 }), 'dx')[9]).toBeCloseTo(100, 9);
    expect(vals(run('adxr', up, { period: 3, lookback: 2 }), 'adxr')[9]).toBeCloseTo(100, 9);
    const d = run('dmi', up, { period: 3, smooth: 3 });
    expect(vals(d, 'minus')[9]).toBeCloseTo(0, 9);
    expect(vals(d, 'plus')[9]).toBeCloseTo(100 / 3, 9); // +DM 1 / TR 3
  });
  it('Aroon oscillator is +100 in a steady climb', () => {
    expect(vals(run('aroon-osc', up, { period: 3 }), 'osc')[9]).toBe(100);
  });
  it('Vortex: VM+ = 4, VM− = 2, TR = 3 per bar → 8/6 and 4/6', () => {
    const v = run('vortex', up, { period: 2 });
    expect(vals(v, 'plus')[9]).toBeCloseTo(8 / 6, 9);
    expect(vals(v, 'minus')[9]).toBeCloseTo(4 / 6, 9);
  });
  it('Mass Index of a constant range = sum length', () => {
    expect(
      vals(run('mass-index', mkBars(Array(10).fill(5)), { ema: 2, sum: 3 }), 'mi')[4],
    ).toBeCloseTo(3, 9);
  });
  it('Alligator shifts the SMMA lines forward', () => {
    const rt = run('alligator', mkBars(Array(30).fill(5)), {});
    expect(vals(rt, 'jaw')[29]).toBeCloseTo(5, 9);
    expect(vals(rt, 'jaw')[18]).toBeNaN(); // SMMA(13) first at 12, + 8 shift
    expect(vals(rt, 'jaw')[20]).toBeCloseTo(5, 9);
  });
  it('Gator is |jaw−teeth| over −|teeth−lips|', () => {
    const rt = run('gator', mkBars(Array.from({ length: 40 }, (_, i) => 100 + i)));
    expect(vals(rt, 'upper')[39]).toBeGreaterThan(0);
    expect(vals(rt, 'lower')[39]).toBeLessThan(0);
  });
  it('Fractals mark the 5-bar extreme, confirmed two bars later', () => {
    const b = ohlcBars([
      [3, 4, 2, 3],
      [3, 5, 2, 3],
      [3, 9, 2, 3],
      [3, 6, 1, 3],
      [3, 4, 2, 3],
      [3, 4, 3, 3],
    ]);
    const rt = run('fractals', b, { n: 2 });
    expect(items<M>(rt, 'up').map((m) => [m.bar, m.value])).toEqual([[2, 9]]);
    expect(items<M>(rt, 'down').map((m) => [m.bar, m.value])).toEqual([[3, 1]]);
  });
  it('Chande Kroll stops bracket a flat market', () => {
    const rt = run('chande-kroll', mkBars(Array(20).fill(10)), { p: 3, x: 1, q: 2 });
    // HH = 11, LL = 9, ATR = 2 → short stop 11 − 2 = 9, long stop 9 + 2 = 11
    expect(vals(rt, 'short')[19]).toBe(9);
    expect(vals(rt, 'long')[19]).toBe(11);
  });
  it('Trend Lines project through the last two swing highs', () => {
    const b = ohlcBars([
      [1, 1, 0, 1],
      [1, 5, 0, 1],
      [1, 2, 0, 1],
      [1, 7, 0, 1],
      [1, 3, 0, 1],
      [1, 2, 0, 1],
    ]);
    const rt = run('trend-lines', b, { left: 1, right: 1 });
    // pivots (1,5), (3,7), slope 1: confirmed at bar 4 → 8, then 9
    expect(vals(rt, 'resistance').slice(3)).toEqual([N, 8, 9]);
  });
  it('Market Structure marks a break of the last swing high', () => {
    const b = ohlcBars([
      [4, 5, 3, 4],
      [5, 8, 6, 7],
      [4, 5, 3, 4],
      [4, 6, 4, 5],
      [6, 10, 7, 9],
      [8, 9, 5, 6],
    ]);
    const rt = run('market-structure', b, { n: 1 });
    const m = items<M>(rt, 'breaks');
    expect(m.map((x) => [x.bar, x.value, x.text, x.tone])).toEqual([[4, 8, 'BOS', 0]]);
    expect(items<{ bar: number; to: number; value: number }>(rt, 'levels')[0]).toMatchObject({
      bar: 1,
      to: 4,
      value: 8,
    });
  });
});

describe('oscillators (batch 2)', () => {
  const flat = mkBars(Array(100).fill(5));
  it('zero-centred oscillators read 0 on a flat market', () => {
    expect(vals(run('ppo', flat), 'ppo')[99]).toBeCloseTo(0, 9);
    expect(vals(run('apo', flat), 'apo')[99]).toBeCloseTo(0, 9);
    expect(vals(run('accelerator', flat), 'ac')[99]).toBeCloseTo(0, 9);
    expect(vals(run('cfo', flat), 'cfo')[99]).toBeCloseTo(0, 9);
    expect(vals(run('coppock', flat), 'cc')[99]).toBeCloseTo(0, 9);
    expect(vals(run('dpo', flat), 'dpo')[99]).toBeCloseTo(0, 9);
    expect(vals(run('kst', flat), 'kst')[99]).toBeCloseTo(0, 9);
    expect(vals(run('smi', flat), 'smi')[99]).toBeCloseTo(0, 9);
    expect(vals(run('wavetrend', flat), 'wt1')[99]).toBeCloseTo(0, 9);
  });
  it('flat-market fixed points: Ultimate 50, DeMarker .5, Laguerre .5', () => {
    expect(vals(run('ultimate', flat), 'uo')[99]).toBeCloseTo(50, 9);
    expect(vals(run('demarker', flat), 'dem')[99]).toBeCloseTo(0.5, 9);
    expect(vals(run('laguerre-rsi', flat), 'lrsi')[99]).toBeCloseTo(0.5, 9);
  });
  it('Elder Ray: H and L relative to the EMA of the close', () => {
    const rt = run('elder-ray', flat, { period: 3 });
    expect(vals(rt, 'bull')[99]).toBeCloseTo(1, 9);
    expect(vals(rt, 'bear')[99]).toBeCloseTo(-1, 9);
  });
  it('PPO of 1→2 step is a percentage of the slow EMA', () => {
    const rt = run('ppo', mkBars([10, 10, 10, 20]), { fast: 2, slow: 3, signal: 1 });
    // EMA2: seed 10, α=2/3 → 10 + 2/3·10 = 16.667; EMA3: α=.5 → 15 → 100·(1.667)/15
    expect(vals(rt, 'ppo')[3]).toBeCloseTo((100 * (50 / 3 - 15)) / 15, 9);
  });
  it('Coppock = WMA(ROC14+ROC11) with hand values', () => {
    const b = mkBars([100, 110, 121]);
    const rt = run('coppock', b, { roc1: 2, roc2: 1, wma: 1 });
    // ROC2(121/100) = 21, ROC1 = 10
    expect(vals(rt, 'cc')[2]).toBeCloseTo(31, 9);
  });
  it('DPO shifts the price back n/2+1 bars', () => {
    const rt = run('dpo', mkBars([1, 2, 3, 4, 5, 6]), { period: 4 });
    // i=5: x[5−3] = 3; SMA(3,4,5,6) = 4.5
    expect(vals(rt, 'dpo')[5]).toBeCloseTo(-1.5, 9);
  });
  it('bounded oscillators stay in range on noise', () => {
    const noise = mkBars(
      Array.from({ length: 300 }, (_, i) => 100 + 10 * Math.sin(i / 3) + ((i * 7919) % 13)),
    );
    for (const [id, out, lo, hi] of [
      ['connors-rsi', 'crsi', 0, 100],
      ['adaptive-rsi', 'rsi', 0, 100],
      ['schaff', 'stc', 0, 100],
      ['qqe', 'rsi', 0, 100],
      ['laguerre-rsi', 'lrsi', 0, 1],
      ['demarker', 'dem', 0, 1],
      ['ultimate', 'uo', 0, 100],
      ['smi', 'smi', -100, 100],
    ] as const) {
      const v = vals(run(id, noise), out).filter((x) => !Number.isNaN(x));
      expect(v.length, id).toBeGreaterThan(100);
      expect(Math.min(...v), id).toBeGreaterThanOrEqual(lo - 1e-9);
      expect(Math.max(...v), id).toBeLessThanOrEqual(hi + 1e-9);
    }
  });
  it('TSI is +100 in a steady climb; Fisher is positive; RVI follows body direction', () => {
    const up = mkBars(Array.from({ length: 60 }, (_, i) => i + 1));
    expect(vals(run('tsi', up, { long: 5, short: 3 }), 'tsi')[59]).toBeCloseTo(100, 6);
    expect(vals(run('fisher', up), 'fisher')[59]).toBeGreaterThan(0);
    expect(vals(run('rvi', up), 'rvi')[59]).toBeGreaterThan(0);
  });
});

describe('volume-based and volatility (batch 2)', () => {
  it('NVI / PVI accumulate on falling / rising volume only', () => {
    const b = mkBars([100, 110, 110], { vol: [10, 5, 8] });
    close(vals(run('nvi', b, { signal: 0 }), 'idx'), [1000, 1100, 1100]);
    close(vals(run('pvi', b, { signal: 0 }), 'idx'), [1000, 1000, 1000]);
  });
  it('Relative Volume, Volume Oscillator, Chaikin Osc, EOM on simple input', () => {
    expect(
      vals(
        run('relative-volume', mkBars([1, 1, 1, 1], { vol: [10, 10, 10, 20] }), { period: 3 }),
        'rvol',
      )[3],
    ).toBe(2);
    expect(vals(run('volume-osc', mkBars(Array(20).fill(5))), 'vo')[19]).toBeCloseTo(0, 9);
    expect(vals(run('chaikin-osc', mkBars(Array(20).fill(5))), 'co')[19]).toBeCloseTo(0, 9);
    expect(vals(run('eom', mkBars(Array(20).fill(5))), 'eom')[19]).toBeCloseTo(0, 9);
  });
  it('Klinger is positive when price and volume rise together', () => {
    const b = mkBars(
      Array.from({ length: 120 }, (_, i) => 100 + i),
      { vol: Array.from({ length: 120 }, () => 50) },
    );
    expect(vals(run('klinger', b), 'kvo').pop()!).not.toBeNaN();
  });
  it('ATRN = 100·ATR/C; HV; Choppiness; Ulcer; Chaikin vol', () => {
    const flat = mkBars(Array(20).fill(5));
    expect(vals(run('atrn', flat, { period: 2 }), 'atrn')[5]).toBeCloseTo(40, 9);
    // returns +ln1.1, −ln1.1: sample σ = ln1.1·√2; annual = 1
    expect(
      vals(run('hist-vol', mkBars([100, 110, 100]), { period: 2, annual: 1 }), 'hv')[2],
    ).toBeCloseTo(100 * Math.SQRT2 * Math.log(1.1), 9);
    // Σ TR(2) = 4, HH − LL = 2 → 100·log2(2)/log2(2)... = 100·log10(2)/log10(2)
    expect(vals(run('choppiness', flat, { period: 2 }), 'chop')[5]).toBeCloseTo(100, 9);
    expect(vals(run('ulcer', flat, { period: 3 }), 'ui')[10]).toBeCloseTo(0, 9);
    expect(vals(run('chaikin-vol', flat), 'cv')[19]).toBeCloseTo(0, 9);
    expect(vals(run('rvi-vol', flat), 'rvi')[19]).toBeCloseTo(50, 9);
  });
  it('Ulcer index of a 10 % drawdown', () => {
    // closes 100, 90: drawdowns 0 and −10 → UI(2) = √((0 + 100)/2)
    const v = vals(run('ulcer', mkBars([100, 100, 90]), { period: 2 }), 'ui');
    expect(v[2]).toBeCloseTo(Math.sqrt(50), 9);
  });
});

describe('levels and structure (batch 2)', () => {
  it('DeMark pivots use the previous day open / close relation', () => {
    const b = ohlcBars(
      [
        [10, 20, 5, 8],
        [9, 12, 8, 10],
      ],
      { ms: DAY },
    );
    const rt = run('pivot-points', b, { type: 'demark' });
    // C < O: X = H + 2L + C = 38 → P = 9.5, R1 = X/2 − L = 14, S1 = X/2 − H = −1
    expect(vals(rt, 'p')[1]).toBe(9.5);
    expect(vals(rt, 'r1')[1]).toBe(14);
    expect(vals(rt, 's1')[1]).toBe(-1);
    expect(vals(rt, 'r2')[1]).toBeNaN();
  });
  it('Fibonacci auto: levels of the last swing leg', () => {
    const b = ohlcBars([
      [3, 4, 3, 3],
      [3, 4, 1, 3],
      [3, 4, 3, 3],
      [4, 6, 5, 5],
      [6, 8, 7, 7],
      [8, 10, 9, 9],
      [8, 8, 7, 7],
    ]);
    const rt = run('fib-auto', b, { left: 1, right: 1 });
    // low 1 (bar 1), high 10 (bar 5, confirmed at 6): H − k·9
    expect(vals(rt, 'f0')[6]).toBe(10);
    expect(vals(rt, 'f3')[6]).toBeCloseTo(5.5, 9);
    expect(vals(rt, 'f6')[6]).toBeCloseTo(1, 9);
  });
  it('FVG: bullish gap zone, closed when price trades back into it', () => {
    const b = ohlcBars([
      [9, 10, 8, 9],
      [10, 13, 10, 12],
      [12, 15, 12, 14],
      [14, 14, 11, 12],
    ]);
    const z = items<Z>(run('fvg', b, { minTicks: 1 }), 'zones');
    expect(z).toEqual([{ bar: 1, to: 3, top: 12, bottom: 10, tone: 0 }]);
  });
  it('Order Blocks: last down candle before a break up', () => {
    const b = ohlcBars([
      [10, 11, 8, 9],
      [9, 10, 9, 9.5],
      [9.5, 10.2, 9.4, 9.6],
      [9.6, 12.5, 9.5, 12],
    ]);
    const z = items<Z>(run('order-blocks', b, { n: 2, lookback: 10 }), 'zones');
    expect(z).toMatchObject([{ bar: 0, top: 11, bottom: 8, tone: 0, to: -1 }]);
  });
  it('Liquidity Sweeps: wick above the swing high that closes back below', () => {
    const b = ohlcBars([
      [4, 5, 3, 4],
      [7, 8, 6, 7],
      [4, 5, 3, 4],
      [7, 9, 5, 7],
    ]);
    const rt = run('liquidity-sweeps', b, { n: 1 });
    expect(items<M>(rt, 'sweeps').map((m) => [m.bar, m.value, m.tone])).toEqual([[3, 9, 1]]);
  });
  it('Gaps: session / bar gaps become zones until filled', () => {
    const b = ohlcBars([
      [10, 10.5, 9.5, 10],
      [12, 13, 11.5, 12.5],
      [12.5, 13, 9.5, 10],
    ]);
    const z = items<Z>(run('gaps', b, { scope: 'bar', minTicks: 1 }), 'zones');
    expect(z).toEqual([{ bar: 1, to: 2, top: 12, bottom: 10, tone: 0 }]);
    expect(items(run('gaps', b, { scope: 'session', minTicks: 1 }), 'zones')).toHaveLength(0);
  });
  it('Opening Range holds the first window of the day', () => {
    const b = mkBars([10, 12, 11, 15, 14], { ms: 900_000 });
    const rt = run('opening-range', b, { minutes: 30 });
    // bars 0 (h 11, l 9) and 1 (h 13, l 9) are inside the window
    expect(vals(rt, 'high')).toEqual([11, 13, 13, 13, 13]);
    expect(vals(rt, 'low')).toEqual([9, 9, 9, 9, 9]);
    expect(vals(rt, 'mid')[4]).toBe(11);
    expect(vals(run('initial-balance', b), 'high')[4]).toBe(16);
  });
  it('Daily Lines and previous D/W/M high-low', () => {
    const b = [
      ...mkBars([10, 12], { t0: 0, ms: 3_600_000 }),
      ...mkBars([13, 11], { t0: DAY, ms: 3_600_000 }),
    ];
    const dl = run('daily-lines', b);
    expect(vals(dl, 'open')[2]).toBe(13);
    expect(vals(dl, 'prevClose')[2]).toBe(12);
    const hl = run('period-high-low', b, { week: false });
    // day 0: highs 11, 13 → PDH 13; lows 9, 9
    expect(vals(hl, 'pdh')[2]).toBe(13);
    expect(vals(hl, 'pdl')[3]).toBe(9);
  });
  it('Session Highs/Lows develop inside the window and hold after', () => {
    const b = mkBars([10, 12, 11, 15], { t0: 7 * 3_600_000 - 3_600_000, ms: 3_600_000 });
    // bar0 at 06:00 outside; bars 1..3 at 07:00-09:00 inside
    const rt = run('session-high-low', b, { start: 7, end: 9 });
    expect(vals(rt, 'high')[0]).toBeNaN();
    expect(vals(rt, 'high')[1]).toBe(13);
    // bar3 at 09:00 is outside (end exclusive): holds
    expect(vals(rt, 'high')[3]).toBe(13);
  });
  it('Seasonality averages earlier bars of the same hour', () => {
    const o = (t: number, o: number, c: number): Bar => ({
      ...mkBars([c])[0]!,
      t,
      tEnd: t + 1,
      o,
      c,
    });
    const b = [o(0, 100, 110), o(3_600_000, 100, 100), o(DAY, 100, 90)];
    const rt = run('seasonality', b, { bucket: 'hour' });
    expect(vals(rt, 'avg')[0]).toBeNaN();
    expect(vals(rt, 'avg')[2]).toBeCloseTo(10, 9);
  });
});

describe('order flow (batch 2)', () => {
  it('Active Volume: totals, or filtered prints', () => {
    const b = mkBars([1]);
    expect(vals(run('active-volume', b), 'buy')[0]).toBe(6);
    expect(vals(run('active-volume', b), 'sell')[0]).toBe(-4);
    const tr = mkTrades([
      [1, 1, 3, 'buy'],
      [2, 1, 6, 'buy'],
      [3, 1, 8, 'sell'],
    ]);
    const rt = run('active-volume', b, { min: 5 }, { tradesBetween: between(tr) });
    expect([vals(rt, 'buy')[0], vals(rt, 'sell')[0], vals(rt, 'net')[0]]).toEqual([6, -8, -2]);
  });
  it('Bars Volume Filter flags volume spikes', () => {
    const rt = run('bars-volume-filter', mkBars([1, 1, 1, 1], { vol: [10, 10, 10, 30] }), {
      period: 3,
      value: 2,
    });
    const m = rt.outputs.m as unknown as { tone: Uint8Array };
    expect(Array.from(m.tone)[3]).toBe(1);
    expect(vals(rt, 'flag')[3]).toBe(30);
  });
  it('Cumulative Delta Volume weights the delta ratio by volume bucket', () => {
    // vol 10, Δ 2 → 0.2 · w(1) · 100 = 20
    expect(vals(run('cumulative-delta-volume', mkBars([1]), { period: 1 }), 'cdv')[0]).toBeCloseTo(
      20,
      9,
    );
  });
  it('Cumulative Daily Volume compares with the average profile', () => {
    const b = [...mkBars([1, 1], { vol: [10, 10] }), ...mkBars([1, 1], { vol: [5, 5], t0: DAY })];
    const rt = run('cumulative-daily-volume', b);
    expect(vals(rt, 'cum')).toEqual([10, 20, 5, 10]);
    expect(vals(rt, 'avg').slice(2)).toEqual([10, 20]);
  });
  it('Dynamic Levels Channel: POC of a one-price profile', () => {
    const rt = run('dynamic-levels-channel', mkBars([5, 5, 5]), { bars: 2 });
    expect(vals(rt, 'poc')).toEqual([5, 5, 5]);
    expect(vals(rt, 'vah')[2]).toBe(5);
  });
  it('Adaptive Big Trades flags prints above μ + kσ of the previous tape', () => {
    const t: [number, number, number, 'buy' | 'sell'][] = [];
    for (let k = 0; k < 30; k++) t.push([k * 100, 100, k % 2 ? 3 : 1, 'buy']);
    t.push([61_000, 100, 4, 'buy'], [61_100, 101, 50, 'sell']);
    const trades = mkTrades(t);
    const bars = mkBars([100, 100]);
    const rt = run(
      'adaptive-big-trades',
      bars,
      { k: 3, window: 100 },
      { tradesBetween: between(trades) },
    );
    // window mean 2, σ 1 → threshold 5: only the 50-lot print
    expect(items<M>(rt, 'bubbles').map((m) => [m.bar, m.value, m.tone, m.text])).toEqual([
      [1, 101, 1, '50'],
    ]);
  });
  it('Order Flow and Time & Sales Filter draw one marker per print', () => {
    const tr = mkTrades([
      [1, 100, 3, 'buy'],
      [2, 101, 9, 'sell'],
      [3, 102, 12, 'buy'],
    ]);
    expect(
      items(run('order-flow-tape', mkBars([100]), {}, { tradesBetween: between(tr) }), 'dots'),
    ).toHaveLength(3);
    const f = run(
      'time-sales-filter',
      mkBars([100]),
      { min: 5, side: 'buy' },
      { tradesBetween: between(tr) },
    );
    expect(items<M>(f, 'dots').map((m) => m.text)).toEqual(['12']);
  });
  it('Tape Patterns finds equal-size same-side runs at regular intervals', () => {
    const tr = mkTrades(
      [0, 100, 200, 300, 400].map((t) => [t, 100, 10, 'buy'] as [number, number, number, 'buy']),
    );
    const rt = run('tape-patterns', mkBars([100]), { repeats: 5 }, { tradesBetween: between(tr) });
    expect(items<M>(rt, 'runs').map((m) => m.text)).toEqual(['5×10']);
    const irregular = mkTrades(
      [0, 100, 700, 710, 2000].map((t) => [t, 100, 10, 'buy'] as [number, number, number, 'buy']),
    );
    expect(
      items(
        run('tape-patterns', mkBars([100]), { repeats: 5 }, { tradesBetween: between(irregular) }),
        'runs',
      ),
    ).toHaveLength(0);
  });
  it('Bars Pattern: unfinished auction at the high', () => {
    const b = mkBars([10]);
    b[0]!.clusters.set(b[0]!.h, { bid: 1, ask: 1, trades: 2, maxTrade: 1 });
    const rt = run('bars-pattern', b, { absorption: false, exhaustion: false });
    expect(items<M>(rt, 'unfinished').map((m) => m.text)).toEqual(['U']);
  });
  it('Cluster Search and Cluster Statistic', () => {
    const b = mkBars([10]);
    const hit = items<M>(run('cluster-search', b, { minVol: 5 }), 'hits');
    expect(hit.map((m) => [m.value, m.text, m.tone])).toEqual([[10, '10', 0]]);
    expect(items(run('cluster-search', b, { minVol: 50 }), 'hits')).toHaveLength(0);
    const g = items<M>(run('cluster-statistic', b), 'grid');
    expect(g.map((m) => m.text)).toEqual(['10', '2', '20%', '5']);
  });
  it('Color bars: new highs / body strength map to tones', () => {
    const hl = run('color-bar-high-low', mkBars([1, 2, 3, 2, 1]), { n: 2 });
    const t = (hl.outputs.bars as unknown as { tone: Uint8Array }).tone;
    expect(Array.from(t.slice(1, 5))).toEqual([2, 0, 2, 1]);
    const oc = run('color-bar-open-close', mkBars([10, 10, 20, 10]), { period: 2, k: 1 });
    const t2 = (oc.outputs.bars as unknown as { tone: Uint8Array }).tone;
    expect(t2[2]).toBe(0);
    expect(t2[3]).toBe(1);
    expect(t2[1]).toBe(2);
  });
  it('Support and Resistance Zones sit on swing highs and lows', () => {
    const b = ohlcBars([
      [4, 5, 3, 4],
      [7, 8, 6, 7],
      [4, 5, 3, 4],
      [4, 5, 2, 4],
      [4, 5, 3, 4],
    ]);
    const z = items<Z>(run('sr-zones', b, { n: 1, period: 2, width: 0.5 }), 'zones');
    expect(z.some((x) => x.tone === 1 && x.bar === 1)).toBe(true);
    expect(z.some((x) => x.tone === 0 && x.bar === 3)).toBe(true);
    expect(z.every((x) => x.top > x.bottom)).toBe(true);
  });
});

describe('crypto metrics (derivatives feed)', () => {
  const bars = mkBars([1, 2, 1]);
  const feeds = () => {
    const log = new DerivativesLog();
    log.addOpenInterest({ kind: 'open_interest', ts: -1, oi: 100, value: 1000 });
    log.addOpenInterest({ kind: 'open_interest', ts: 30_000, oi: 110, value: 1100 });
    log.addOpenInterest({ kind: 'open_interest', ts: 70_000, oi: 105, value: 1050 });
    log.addFunding({ kind: 'funding', ts: -5, rate: 0.0001, nextTs: 0, markPrice: 1 });
    log.addFunding({ kind: 'funding', ts: 65_000, rate: -0.0002, nextTs: 0, markPrice: 1 });
    log.addLiquidations([{ kind: 'liquidation', ts: 1000, side: 'sell', px: 7, qty: 50 }]);
    return log;
  };
  it('say "no data from this feed" without a feed and do not break', () => {
    for (const id of [
      'funding-rate',
      'open-interest',
      'oi-analyzer',
      'balance-oi',
      'liquidation-heatmap',
    ]) {
      const rt = run(id, bars);
      expect(rt.notice, id).toBe('no data from this feed');
    }
    const empty = run('open-interest', bars, {}, { derivatives: new DerivativesLog() });
    expect(empty.notice).toBe('no data from this feed');
    expect(vals(empty, 'oi').every(Number.isNaN)).toBe(true);
  });
  it('Funding Rate Tracker: % rate in force at the bar close', () => {
    const rt = run('funding-rate', bars, {}, { derivatives: feeds() });
    expect(rt.notice).toBeNull();
    close(vals(rt, 'rate'), [0.01, -0.02, -0.02]);
    close(
      vals(
        run('funding-rate', bars, { annualize: true, perDay: 3 }, { derivatives: feeds() }),
        'rate',
      ),
      [10.95, -21.9, -21.9],
    );
  });
  it('Open Interest: level and change per bar', () => {
    const rt = run('open-interest', bars, {}, { derivatives: feeds() });
    close(vals(rt, 'oi'), [110, 105, 105]);
    close(vals(rt, 'delta'), [10, -5, 0]);
    expect(
      vals(run('open-interest', bars, { unit: 'value' }, { derivatives: feeds() }), 'oi')[0],
    ).toBe(1100);
  });
  it('OI Analyzer classifies price vs OI', () => {
    const rt = run('oi-analyzer', bars, {}, { derivatives: feeds() });
    // bar0: flat price (up), OI +10 → long build-up; bar1: price up, OI −5 → short covering
    expect(items<M>(rt, 'tag').map((m) => m.text)).toEqual(['LB', 'SC']);
  });
  it('Balance OI accumulates sign(price)·|ΔOI|', () => {
    const rt = run('balance-oi', bars, { reset: 'never' }, { derivatives: feeds() });
    close(vals(rt, 'bal').slice(0, 2), [0, 5]);
    expect(vals(rt, 'bal')[2]).toBeCloseTo(5 - 0, 9); // bar 2: ΔOI 0
  });
  it('Liquidation Heatmap: actual bubbles and estimated levels', () => {
    const b = mkBars([100, 100, 100, 100], { vol: [10, 10, 10, 100] });
    const log = new DerivativesLog();
    log.addLiquidations([{ kind: 'liquidation', ts: 1000, side: 'sell', px: 99, qty: 40 }]);
    const rt = run(
      'liquidation-heatmap',
      b,
      { period: 3, t1: 10, t2: 0, t3: 0, t4: 0 },
      { derivatives: log },
    );
    expect(items<M>(rt, 'liqs').map((m) => [m.bar, m.value, m.tone])).toEqual([[0, 99, 1]]);
    const lv = items<{ bar: number; value: number; tone: number }>(rt, 'levels');
    expect(lv.map((l) => [l.bar, +l.value.toFixed(6), l.tone])).toEqual([
      [3, 90, 0],
      [3, 110, 1],
    ]);
  });
});

describe('order book (depth feed)', () => {
  const col = (t: number, pxs: number[], qtys: number[]): DepthColumn => ({
    t,
    bestBid: 100,
    bestAsk: 101,
    pxs: Int32Array.from(pxs),
    qtys: Float32Array.from(qtys),
  });
  const depth = {
    version: 1,
    columns: [col(1000, [100, 99, 101, 102], [10, 10, 30, 10])],
  };
  it('say "no data from this feed" without depth', () => {
    for (const id of ['dom-depth', 'dom-power', 'dom-levels', 'iceberg-tracker']) {
      expect(run(id, mkBars([100])).notice, id).toBe('no data from this feed');
    }
  });
  it('Depth of Market and DOM Power: bid 20 vs ask 40', () => {
    const d = run('dom-depth', mkBars([100]), { ticks: 10 }, { depth });
    expect([vals(d, 'bid')[0], vals(d, 'ask')[0]]).toEqual([20, -40]);
    close(vals(run('dom-power', mkBars([100]), { ticks: 10 }, { depth }), 'power'), [-20 / 60]);
    // touch only: bid 10 vs ask 30
    const near = run('dom-power', mkBars([100]), { ticks: 1 }, { depth });
    close(vals(near, 'power'), [(20 - 40) / 60]);
  });
  it('DOM Levels draws the big resting order', () => {
    const rt = run('dom-levels', mkBars([100]), { ticks: 10, k: 2 }, { depth });
    expect(
      items<{ value: number; tone: number; label: string }>(rt, 'levels').map((l) => [
        l.value,
        l.tone,
        l.label,
      ]),
    ).toEqual([[101, 1, '30']]);
  });
  it('Iceberg Tracker: traded volume far above the displayed size', () => {
    const b = mkBars([100]);
    b[0]!.clusters.set(100, { bid: 50, ask: 0, trades: 9, maxTrade: 5 });
    const rt = run('iceberg-tracker', b, { ratio: 3, min: 10 }, { depth });
    expect(items<M>(rt, 'hits').map((m) => [m.value, m.tone, m.text])).toEqual([[100, 0, '50/10']]);
  });
  it('Sweeps Tracker: one aggressive buy through four ticks', () => {
    const tr = mkTrades([
      [1, 100, 2, 'buy'],
      [3, 101, 2, 'buy'],
      [5, 102, 2, 'buy'],
      [7, 103, 2, 'buy'],
      [5000, 103, 1, 'sell'],
    ]);
    const rt = run('sweeps-tracker', mkBars([100]), { levels: 3 }, { tradesBetween: between(tr) });
    expect(items<M>(rt, 'sweeps').map((m) => [m.value, m.tone, m.text])).toEqual([[103, 0, '4×8']]);
  });
  it('Stop Runs Tracker: fast break of the extreme that is rejected', () => {
    const b = mkBars([10, 10, 10, 10, 10]);
    b[4]!.h = 14;
    const rt = run('stop-runs', b, { n: 2, minTicks: 1, speed: 0 });
    expect(items<M>(rt, 'runs').map((m) => [m.bar, m.tone])).toEqual([[4, 1]]);
  });
});

describe('samples and trading', () => {
  it('Bar Numbering restarts at the reset', () => {
    const b = [...mkBars([1, 1, 1]), ...mkBars([1, 1], { t0: DAY })];
    const rt = run('bar-numbering', b, { reset: 'session' });
    expect(items<M>(rt, 'labels').map((m) => m.text)).toEqual(['1', '2', '3', '1', '2']);
  });
  it('Bar Timer shows the time left on the last bar only', () => {
    const rt = run('bar-timer', mkBars([1, 1]), { length: 60 });
    // last bar: tEnd − t = 59 s → 1 s left
    expect(items<M>(rt, 'label').map((m) => [m.bar, m.text])).toEqual([[1, '0:01']]);
  });
  it('Trading Session Visualizer boxes a session between its high and low', () => {
    const b = mkBars([10, 12, 11, 15], { t0: 6 * 3_600_000, ms: 3_600_000 });
    const rt = run('session-visualizer', b, {
      asia: false,
      ny: false,
      londonStart: 7,
      londonEnd: 9,
    });
    expect(items<Z & { label: string }>(rt, 'boxes')).toMatchObject([
      { bar: 1, to: 2, top: 13, bottom: 9, label: 'London' },
    ]);
  });
});
