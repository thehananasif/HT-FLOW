import {
  HT,
  defineIndicator,
  ema,
  highest,
  input,
  linreg,
  lowest,
  output,
  rma,
  sma,
  sum,
  wma,
  type CalcContext,
  type InputDefs,
  type OutputDefs,
} from '@htflow/indicator-sdk';
import { MA_TYPES, maAt, srcLabel, type MaType } from './common';

const osc = {
  category: 'technical' as const,
  group: 'Momentum & oscillators',
  pane: 'new' as const,
};
const NaN_ = Number.NaN;

type AnyCtx = CalcContext<InputDefs, OutputDefs, unknown>;

/** Wilder RSI value at bar i of `s` using scratch buffers with the given prefix. */
function rsiOf(ctx: AnyCtx, s: ArrayLike<number>, n: number, p: string): number {
  const i = ctx.i;
  const g = ctx.buf(p + 'g');
  const l = ctx.buf(p + 'l');
  if (i > 0) {
    const d = s[i]! - s[i - 1]!;
    g[i] = Math.max(0, d);
    l[i] = Math.max(0, -d);
  }
  const ag = ctx.buf(p + 'ag');
  const al = ctx.buf(p + 'al');
  ag[i] = rma(ag, g, i, n);
  al[i] = rma(al, l, i, n);
  const a = ag[i]!;
  const b = al[i]!;
  return Number.isNaN(a) ? a : b === 0 ? (a === 0 ? 50 : 100) : 100 - 100 / (1 + a / b);
}

const roc = (s: ArrayLike<number>, i: number, n: number) =>
  i >= n && s[i - n]! !== 0 ? (100 * (s[i]! - s[i - n]!)) / s[i - n]! : NaN_;

export const PPO = defineIndicator({
  id: 'ppo',
  name: 'Percentage Price Oscillator',
  short: 'PPO',
  ...osc,
  description: 'MACD expressed as a percentage of the slow EMA.',
  formula:
    'PPO = 100·(EMA(fast) − EMA(slow)) / EMA(slow); Signal = EMA(PPO, s); Hist = PPO − Signal',
  zeroLine: true,
  inputs: {
    fast: input.int('Fast', 12, { min: 1, max: 500 }),
    slow: input.int('Slow', 26, { min: 1, max: 500 }),
    signal: input.int('Signal', 9, { min: 1, max: 500 }),
    source: input.source('Source', 'close'),
  },
  outputs: {
    hist: output.histogram('Histogram', HT.up, { color2: HT.down, opacity: 0.7, unit: 'percent' }),
    ppo: output.line('PPO', HT.info, { unit: 'percent' }),
    signal: output.line('Signal', HT.warning, { unit: 'percent' }),
  },
  title: (p) => `PPO ${p.fast} ${p.slow} ${p.signal}${srcLabel(p.source)}`,
  calc(ctx) {
    const s = ctx.src(ctx.inputs.source);
    const f = ctx.buf('f');
    const sl = ctx.buf('s');
    f[ctx.i] = ema(f, s, ctx.i, ctx.inputs.fast);
    sl[ctx.i] = ema(sl, s, ctx.i, ctx.inputs.slow);
    const m = ctx.out.ppo.v;
    m[ctx.i] = sl[ctx.i]! !== 0 ? (100 * (f[ctx.i]! - sl[ctx.i]!)) / sl[ctx.i]! : NaN_;
    const sg = ctx.out.signal.v;
    sg[ctx.i] = ema(sg, m, ctx.i, ctx.inputs.signal);
    const h = m[ctx.i]! - sg[ctx.i]!;
    ctx.out.hist.set(ctx.i, h, h >= 0 ? 0 : 1);
  },
});

export const APO = defineIndicator({
  id: 'apo',
  name: 'Absolute Price Oscillator',
  short: 'APO',
  ...osc,
  description: 'Difference of a fast and a slow moving average.',
  formula: 'APO = MA(fast) − MA(slow)',
  zeroLine: true,
  inputs: {
    type: input.enum('MA type', 'ema', MA_TYPES),
    fast: input.int('Fast', 12, { min: 1, max: 500 }),
    slow: input.int('Slow', 26, { min: 1, max: 500 }),
    source: input.source('Source', 'close'),
  },
  outputs: { apo: output.histogram('APO', HT.up, { color2: HT.down, opacity: 0.8 }) },
  title: (p) => `APO ${p.fast} ${p.slow}${srcLabel(p.source)}`,
  calc(ctx) {
    const s = ctx.src(ctx.inputs.source);
    const f = ctx.buf('f');
    const sl = ctx.buf('s');
    const t = ctx.inputs.type as MaType;
    f[ctx.i] = maAt(t, f, s, ctx.i, ctx.inputs.fast);
    sl[ctx.i] = maAt(t, sl, s, ctx.i, ctx.inputs.slow);
    const v = f[ctx.i]! - sl[ctx.i]!;
    ctx.out.apo.set(ctx.i, v, v >= 0 ? 0 : 1);
  },
});

export const Accelerator = defineIndicator({
  id: 'accelerator',
  name: 'Accelerator Oscillator',
  short: 'AC',
  ...osc,
  description: "Bill Williams' AC: the Awesome Oscillator minus its 5-bar SMA.",
  formula: 'AO = SMA(HL2, 5) − SMA(HL2, 34); AC = AO − SMA(AO, 5)',
  zeroLine: true,
  inputs: {
    fast: input.int('AO fast', 5, { min: 1, max: 200 }),
    slow: input.int('AO slow', 34, { min: 2, max: 500 }),
    smooth: input.int('AC smoothing', 5, { min: 1, max: 200 }),
  },
  outputs: { ac: output.histogram('AC', HT.up, { color2: HT.down, opacity: 0.8 }) },
  title: (p) => `AC ${p.fast} ${p.slow} ${p.smooth}`,
  calc(ctx) {
    const hl2 = ctx.src('hl2');
    const ao = ctx.buf('ao');
    ao[ctx.i] = sma(hl2, ctx.i, ctx.inputs.fast) - sma(hl2, ctx.i, ctx.inputs.slow);
    const v = ao[ctx.i]! - sma(ao, ctx.i, ctx.inputs.smooth);
    const prev = ctx.i > 0 ? ctx.out.ac.v[ctx.i - 1]! : NaN_;
    ctx.out.ac.set(ctx.i, v, Number.isNaN(prev) || v >= prev ? 0 : 1);
  },
});

export const CFO = defineIndicator({
  id: 'cfo',
  name: 'Chande Forecast Oscillator',
  short: 'CFO',
  ...osc,
  description: 'Percentage difference between price and its linear-regression forecast.',
  formula: 'CFO = 100·(x − LinReg(x, n)) / x',
  zeroLine: true,
  inputs: {
    period: input.int('Period', 14, { min: 2, max: 500 }),
    source: input.source('Source', 'close'),
  },
  outputs: { cfo: output.line('CFO', HT.info, { unit: 'percent' }) },
  title: (p) => `CFO ${p.period}${srcLabel(p.source)}`,
  calc(ctx) {
    const s = ctx.src(ctx.inputs.source);
    const lr = linreg(s, ctx.i, ctx.inputs.period);
    ctx.out.cfo.set(ctx.i, s[ctx.i]! !== 0 ? (100 * (s[ctx.i]! - lr.value)) / s[ctx.i]! : NaN_);
  },
});

export const Coppock = defineIndicator({
  id: 'coppock',
  name: 'Coppock Curve',
  short: 'Coppock',
  ...osc,
  description:
    'Weighted moving average of the sum of two rates of change; long-term momentum buy signals.',
  formula: 'Coppock = WMA(ROC(a) + ROC(b), n)',
  zeroLine: true,
  inputs: {
    roc1: input.int('Long ROC', 14, { min: 1, max: 500 }),
    roc2: input.int('Short ROC', 11, { min: 1, max: 500 }),
    wma: input.int('WMA period', 10, { min: 1, max: 500 }),
    source: input.source('Source', 'close'),
  },
  outputs: { cc: output.line('Coppock', HT.info, { unit: 'percent' }) },
  title: (p) => `Coppock ${p.roc1} ${p.roc2} ${p.wma}${srcLabel(p.source)}`,
  calc(ctx) {
    const s = ctx.src(ctx.inputs.source);
    const r = ctx.buf('r');
    r[ctx.i] = roc(s, ctx.i, ctx.inputs.roc1) + roc(s, ctx.i, ctx.inputs.roc2);
    ctx.out.cc.set(ctx.i, wma(r, ctx.i, ctx.inputs.wma));
  },
});

export const DeMarker = defineIndicator({
  id: 'demarker',
  name: 'DeMarker',
  short: 'DeM',
  ...osc,
  description: 'Compares the current high / low with the previous bar to find exhaustion.',
  formula:
    'DeMax = max(H − H₋, 0); DeMin = max(L₋ − L, 0); DeM = SMA(DeMax)/(SMA(DeMax) + SMA(DeMin))',
  range: [0, 1],
  inputs: { period: input.int('Period', 14, { min: 1, max: 500 }) },
  outputs: { dem: output.line('DeM', HT.special) },
  guides: () => [0.3, 0.7],
  title: (p) => `DeMarker ${p.period}`,
  calc(ctx) {
    const i = ctx.i;
    if (i === 0) return;
    const p = ctx.bars[i - 1]!;
    const mx = ctx.buf('mx');
    const mn = ctx.buf('mn');
    mx[i] = Math.max(ctx.bar.h - p.h, 0);
    mn[i] = Math.max(p.l - ctx.bar.l, 0);
    const a = sma(mx, i, ctx.inputs.period);
    const b = sma(mn, i, ctx.inputs.period);
    ctx.out.dem.set(i, a + b > 0 ? a / (a + b) : Number.isNaN(a) ? NaN_ : 0.5);
  },
});

export const DPO = defineIndicator({
  id: 'dpo',
  name: 'Detrended Price Oscillator',
  short: 'DPO',
  ...osc,
  description:
    'Price shifted back by half the period minus its SMA, removing the trend to expose cycles.',
  formula: 'DPO = x[n/2 + 1 bars ago] − SMA(x, n)',
  zeroLine: true,
  inputs: {
    period: input.int('Period', 20, { min: 2, max: 500 }),
    source: input.source('Source', 'close'),
  },
  outputs: { dpo: output.line('DPO', HT.info) },
  title: (p) => `DPO ${p.period}${srcLabel(p.source)}`,
  calc(ctx) {
    const n = ctx.inputs.period;
    const s = ctx.src(ctx.inputs.source);
    const k = ctx.i - (Math.floor(n / 2) + 1);
    if (k < 0) return;
    ctx.out.dpo.set(ctx.i, s[k]! - sma(s, ctx.i, n));
  },
});

export const UltimateOsc = defineIndicator({
  id: 'ultimate',
  name: 'Ultimate Oscillator',
  short: 'UO',
  ...osc,
  description: "Williams' oscillator combining buying pressure over three timeframes.",
  formula:
    'BP = C − min(L, C₋); TR = max(H, C₋) − min(L, C₋); UO = 100·(4·A₇ + 2·A₁₄ + A₂₈)/7, A_n = ΣBP/ΣTR',
  range: [0, 100],
  inputs: {
    p1: input.int('Short', 7, { min: 1, max: 100 }),
    p2: input.int('Medium', 14, { min: 1, max: 200 }),
    p3: input.int('Long', 28, { min: 1, max: 500 }),
  },
  outputs: { uo: output.line('UO', HT.special) },
  guides: () => [30, 50, 70],
  title: (p) => `UO ${p.p1} ${p.p2} ${p.p3}`,
  calc(ctx) {
    const i = ctx.i;
    if (i === 0) return;
    const pc = ctx.bars[i - 1]!.c;
    const bp = ctx.buf('bp');
    const tr = ctx.buf('tr');
    bp[i] = ctx.bar.c - Math.min(ctx.bar.l, pc);
    tr[i] = Math.max(ctx.bar.h, pc) - Math.min(ctx.bar.l, pc);
    const a = (n: number) => {
      const t = sum(tr, i, n);
      return t > 0 ? sum(bp, i, n) / t : NaN_;
    };
    const { p1, p2, p3 } = ctx.inputs;
    ctx.out.uo.set(i, (100 * (4 * a(p1) + 2 * a(p2) + a(p3))) / 7);
  },
});

export const KST = defineIndicator({
  id: 'kst',
  name: 'Know Sure Thing',
  short: 'KST',
  ...osc,
  description: "Pring's KST: weighted sum of four smoothed rates of change, with a signal line.",
  formula:
    'KST = 1·SMA(ROC₁,s₁) + 2·SMA(ROC₂,s₂) + 3·SMA(ROC₃,s₃) + 4·SMA(ROC₄,s₄); Signal = SMA(KST, 9)',
  zeroLine: true,
  inputs: {
    r1: input.int('ROC 1', 10, { min: 1, max: 500 }),
    r2: input.int('ROC 2', 15, { min: 1, max: 500 }),
    r3: input.int('ROC 3', 20, { min: 1, max: 500 }),
    r4: input.int('ROC 4', 30, { min: 1, max: 500 }),
    s1: input.int('SMA 1', 10, { min: 1, max: 200 }),
    s2: input.int('SMA 2', 10, { min: 1, max: 200 }),
    s3: input.int('SMA 3', 10, { min: 1, max: 200 }),
    s4: input.int('SMA 4', 15, { min: 1, max: 200 }),
    signal: input.int('Signal', 9, { min: 1, max: 200 }),
    source: input.source('Source', 'close'),
  },
  outputs: {
    kst: output.line('KST', HT.info, { unit: 'percent' }),
    signal: output.line('Signal', HT.warning, { unit: 'percent' }),
  },
  title: (p) => `KST${srcLabel(p.source)}`,
  calc(ctx) {
    const s = ctx.src(ctx.inputs.source);
    const i = ctx.i;
    const q = ctx.inputs;
    const rs = [q.r1, q.r2, q.r3, q.r4];
    const ss = [q.s1, q.s2, q.s3, q.s4];
    let k = 0;
    for (let x = 0; x < 4; x++) {
      const b = ctx.buf('r' + x);
      b[i] = roc(s, i, rs[x]!);
      k += (x + 1) * sma(b, i, ss[x]!);
    }
    const o = ctx.out.kst.v;
    o[i] = k;
    ctx.out.signal.set(i, sma(o, i, q.signal));
  },
});

export const ElderRay = defineIndicator({
  id: 'elder-ray',
  name: 'Elder Ray',
  short: 'Elder Ray',
  ...osc,
  description:
    'Bull and bear power: how far the high / low reach beyond a 13-bar EMA of the close.',
  formula: 'Bull = H − EMA(C, n); Bear = L − EMA(C, n)',
  zeroLine: true,
  inputs: { period: input.int('EMA period', 13, { min: 1, max: 500 }) },
  outputs: {
    bull: output.histogram('Bull power', HT.up, { color2: HT.down, opacity: 0.7 }),
    bear: output.histogram('Bear power', HT.down, { color2: HT.up, opacity: 0.7 }),
  },
  title: (p) => `Elder Ray ${p.period}`,
  calc(ctx) {
    const e = ctx.buf('e');
    e[ctx.i] = ema(e, ctx.src('close'), ctx.i, ctx.inputs.period);
    const bu = ctx.bar.h - e[ctx.i]!;
    const be = ctx.bar.l - e[ctx.i]!;
    ctx.out.bull.set(ctx.i, bu, bu >= 0 ? 0 : 1);
    ctx.out.bear.set(ctx.i, be, be <= 0 ? 0 : 1);
  },
});

export const Fisher = defineIndicator({
  id: 'fisher',
  name: 'Fisher Transform',
  short: 'Fisher',
  ...osc,
  description:
    'Gaussian-normalises the position of the median price in its range to give sharp turning points.',
  formula:
    'v = 0.66·((HL2 − LL)/(HH − LL) − 0.5) + 0.67·v₋ (clamped ±0.999); Fisher = 0.5·ln((1+v)/(1−v)) + 0.5·Fisher₋',
  zeroLine: true,
  inputs: { period: input.int('Period', 9, { min: 2, max: 500 }) },
  outputs: {
    fisher: output.line('Fisher', HT.info),
    trigger: output.line('Trigger', HT.warning, { width: 1 }),
  },
  title: (p) => `Fisher ${p.period}`,
  calc(ctx) {
    const i = ctx.i;
    const n = ctx.inputs.period;
    const hh = highest(ctx.src('high'), i, n);
    const ll = lowest(ctx.src('low'), i, n);
    if (Number.isNaN(hh + ll)) return;
    const v = ctx.buf('v');
    const f = ctx.out.fisher.v;
    const pv = i > 0 && !Number.isNaN(v[i - 1]!) ? v[i - 1]! : 0;
    const pf = i > 0 && !Number.isNaN(f[i - 1]!) ? f[i - 1]! : 0;
    const pos = hh > ll ? (ctx.src('hl2')[i]! - ll) / (hh - ll) - 0.5 : 0;
    v[i] = Math.max(-0.999, Math.min(0.999, 0.66 * pos + 0.67 * pv));
    f[i] = 0.5 * Math.log((1 + v[i]!) / (1 - v[i]!)) + 0.5 * pf;
    ctx.out.trigger.set(i, pf);
  },
});

export const SchaffTC = defineIndicator({
  id: 'schaff',
  name: 'Schaff Trend Cycle',
  short: 'STC',
  ...osc,
  description:
    'MACD run through two cascaded stochastic smoothings: a fast, bounded cycle oscillator.',
  formula:
    'M = EMA(fast) − EMA(slow); %K₁ = stoch(M, cycle); P₁ = smooth(%K₁); %K₂ = stoch(P₁, cycle); STC = smooth(%K₂)',
  range: [0, 100],
  inputs: {
    fast: input.int('Fast', 23, { min: 1, max: 500 }),
    slow: input.int('Slow', 50, { min: 2, max: 500 }),
    cycle: input.int('Cycle', 10, { min: 2, max: 500 }),
    factor: input.float('Smoothing factor', 0.5, { min: 0.05, max: 1, step: 0.05 }),
    source: input.source('Source', 'close'),
  },
  outputs: { stc: output.line('STC', HT.special) },
  guides: () => [25, 75],
  title: (p) => `STC ${p.fast} ${p.slow} ${p.cycle}${srcLabel(p.source)}`,
  calc(ctx) {
    const { fast, slow, cycle, factor } = ctx.inputs;
    const i = ctx.i;
    const s = ctx.src(ctx.inputs.source);
    const f = ctx.buf('f');
    const sl = ctx.buf('s');
    f[i] = ema(f, s, i, fast);
    sl[i] = ema(sl, s, i, slow);
    const m = ctx.buf('m');
    m[i] = f[i]! - sl[i]!;
    const hh = highest(m, i, cycle);
    const ll = lowest(m, i, cycle);
    if (Number.isNaN(hh + ll)) return;
    const k1 = ctx.buf('k1');
    const p1 = ctx.buf('p1');
    const k2 = ctx.buf('k2');
    const st = ctx.out.stc.v;
    const prevOr = (a: Float64Array, d: number) =>
      i > 0 && !Number.isNaN(a[i - 1]!) ? a[i - 1]! : d;
    k1[i] = hh > ll ? ((m[i]! - ll) / (hh - ll)) * 100 : prevOr(k1, 0);
    p1[i] = Number.isNaN(prevOr(p1, NaN_)) ? k1[i]! : p1[i - 1]! + factor * (k1[i]! - p1[i - 1]!);
    const h2 = highest(p1, i, cycle);
    const l2 = lowest(p1, i, cycle);
    if (Number.isNaN(h2 + l2)) return;
    k2[i] = h2 > l2 ? ((p1[i]! - l2) / (h2 - l2)) * 100 : prevOr(k2, 0);
    st[i] = Number.isNaN(prevOr(st, NaN_)) ? k2[i]! : st[i - 1]! + factor * (k2[i]! - st[i - 1]!);
  },
});

export const TSI = defineIndicator({
  id: 'tsi',
  name: 'True Strength Index',
  short: 'TSI',
  ...osc,
  description: 'Double-smoothed momentum relative to double-smoothed absolute momentum.',
  formula: 'TSI = 100·EMA(EMA(Δx, r), s) / EMA(EMA(|Δx|, r), s); Signal = EMA(TSI, n)',
  zeroLine: true,
  inputs: {
    long: input.int('Long (r)', 25, { min: 1, max: 500 }),
    short: input.int('Short (s)', 13, { min: 1, max: 500 }),
    signal: input.int('Signal', 7, { min: 1, max: 200 }),
    source: input.source('Source', 'close'),
  },
  outputs: {
    tsi: output.line('TSI', HT.info),
    signal: output.line('Signal', HT.warning, { width: 1 }),
  },
  title: (p) => `TSI ${p.long} ${p.short} ${p.signal}${srcLabel(p.source)}`,
  calc(ctx) {
    const i = ctx.i;
    if (i === 0) return;
    const s = ctx.src(ctx.inputs.source);
    const m = ctx.buf('m');
    const am = ctx.buf('am');
    m[i] = s[i]! - s[i - 1]!;
    am[i] = Math.abs(m[i]!);
    const a1 = ctx.buf('a1');
    const a2 = ctx.buf('a2');
    const b1 = ctx.buf('b1');
    const b2 = ctx.buf('b2');
    a1[i] = ema(a1, m, i, ctx.inputs.long);
    a2[i] = ema(a2, a1, i, ctx.inputs.short);
    b1[i] = ema(b1, am, i, ctx.inputs.long);
    b2[i] = ema(b2, b1, i, ctx.inputs.short);
    const t = ctx.out.tsi.v;
    t[i] = b2[i]! > 0 ? (100 * a2[i]!) / b2[i]! : Number.isNaN(b2[i]!) ? NaN_ : 0;
    ctx.out.signal.set(i, ema(ctx.out.signal.v, t, i, ctx.inputs.signal));
  },
});

export const RVI = defineIndicator({
  id: 'rvi',
  name: 'Relative Vigor Index',
  short: 'RVI',
  ...osc,
  description:
    'Compares the close-open move with the high-low range: closes tend to be higher than opens in uptrends.',
  formula:
    'num = SWMA(C − O), den = SWMA(H − L) (weights 1,2,2,1 /6); RVI = SMA(num, n)/SMA(den, n); Signal = SWMA(RVI)',
  zeroLine: true,
  inputs: { period: input.int('Period', 10, { min: 1, max: 500 }) },
  outputs: {
    rvi: output.line('RVI', HT.up),
    signal: output.line('Signal', HT.down, { width: 1 }),
  },
  title: (p) => `RVI ${p.period}`,
  calc(ctx) {
    const i = ctx.i;
    const co = ctx.buf('co');
    const hl = ctx.buf('hl');
    co[i] = ctx.bar.c - ctx.bar.o;
    hl[i] = ctx.bar.h - ctx.bar.l;
    const sw = (a: Float64Array) =>
      i >= 3 ? (a[i]! + 2 * a[i - 1]! + 2 * a[i - 2]! + a[i - 3]!) / 6 : NaN_;
    const num = ctx.buf('num');
    const den = ctx.buf('den');
    num[i] = sw(co);
    den[i] = sw(hl);
    const d = sma(den, i, ctx.inputs.period);
    const r = ctx.out.rvi.v;
    r[i] = d > 0 ? sma(num, i, ctx.inputs.period) / d : NaN_;
    if (i >= 3) ctx.out.signal.set(i, sw(r));
  },
});

export const ConnorsRSI = defineIndicator({
  id: 'connors-rsi',
  name: 'Connors RSI',
  short: 'CRSI',
  ...osc,
  description:
    'Average of a short RSI, an RSI of the up/down streak length and the percent rank of the 1-bar change.',
  formula: 'CRSI = (RSI(C, 3) + RSI(streak, 2) + PercentRank(ROC(1), 100)) / 3',
  range: [0, 100],
  inputs: {
    rsi: input.int('RSI period', 3, { min: 2, max: 100 }),
    streak: input.int('Streak RSI period', 2, { min: 2, max: 100 }),
    rank: input.int('Percent-rank bars', 100, { min: 2, max: 1000 }),
  },
  outputs: { crsi: output.line('CRSI', HT.special) },
  guides: () => [10, 50, 90],
  title: (p) => `CRSI ${p.rsi} ${p.streak} ${p.rank}`,
  calc(ctx) {
    const i = ctx.i;
    const c = ctx.src('close');
    const st = ctx.buf('st');
    const r1 = ctx.buf('r1');
    if (i > 0) {
      const d = c[i]! - c[i - 1]!;
      const ps = i > 1 ? st[i - 1]! : 0;
      st[i] = d > 0 ? (ps > 0 ? ps + 1 : 1) : d < 0 ? (ps < 0 ? ps - 1 : -1) : 0;
      r1[i] = c[i - 1]! !== 0 ? (100 * d) / c[i - 1]! : 0;
    } else st[0] = 0;
    const a = rsiOf(ctx as unknown as AnyCtx, c, ctx.inputs.rsi, 'a');
    const b = rsiOf(ctx as unknown as AnyCtx, st, ctx.inputs.streak, 'b');
    const n = ctx.inputs.rank;
    if (i < n) return;
    let lower = 0;
    for (let k = 1; k <= n; k++) if (r1[i - k]! < r1[i]!) lower++;
    ctx.out.crsi.set(i, (a + b + (100 * lower) / n) / 3);
  },
});

export const LaguerreRSI = defineIndicator({
  id: 'laguerre-rsi',
  name: 'Laguerre RSI',
  short: 'LRSI',
  ...osc,
  description: "Ehlers' RSI on a four-element Laguerre filter: very smooth with little lag.",
  formula:
    'L0 = (1−γ)x + γL0₋; L1 = −γL0 + L0₋ + γL1₋; …; RSI = ΣmaxΔ↑/(ΣΔ↑ + ΣΔ↓) with Δ = L_k − L_{k+1}',
  range: [0, 1],
  inputs: {
    gamma: input.float('Gamma', 0.5, { min: 0, max: 0.99, step: 0.05 }),
    source: input.source('Source', 'close'),
  },
  outputs: { lrsi: output.line('LRSI', HT.info) },
  guides: () => [0.2, 0.8],
  title: (p) => `LRSI ${p.gamma}${srcLabel(p.source)}`,
  calc(ctx) {
    const g = ctx.inputs.gamma;
    const i = ctx.i;
    const x = ctx.src(ctx.inputs.source)[i]!;
    const L = [0, 1, 2, 3].map((k) => ctx.buf('l' + k));
    if (i === 0) {
      for (const a of L) a[0] = x;
    } else {
      L[0]![i] = (1 - g) * x + g * L[0]![i - 1]!;
      L[1]![i] = -g * L[0]![i]! + L[0]![i - 1]! + g * L[1]![i - 1]!;
      L[2]![i] = -g * L[1]![i]! + L[1]![i - 1]! + g * L[2]![i - 1]!;
      L[3]![i] = -g * L[2]![i]! + L[2]![i - 1]! + g * L[3]![i - 1]!;
    }
    let cu = 0;
    let cd = 0;
    for (let k = 0; k < 3; k++) {
      const d = L[k]![i]! - L[k + 1]![i]!;
      if (d >= 0) cu += d;
      else cd -= d;
    }
    ctx.out.lrsi.set(i, cu + cd > 0 ? cu / (cu + cd) : 0.5);
  },
});

export const SMI = defineIndicator({
  id: 'smi',
  name: 'Stochastic Momentum Index',
  short: 'SMI',
  ...osc,
  description: "Blau's SMI: distance of the close from the midpoint of the range, double-smoothed.",
  formula:
    'M = C − (HH+LL)/2; D = HH − LL; SMI = 100·EMA(EMA(M))/(0.5·EMA(EMA(D))); Signal = EMA(SMI)',
  range: [-100, 100],
  zeroLine: true,
  inputs: {
    k: input.int('%K period', 10, { min: 2, max: 500 }),
    d: input.int('First smoothing', 3, { min: 1, max: 100 }),
    smooth: input.int('Second smoothing', 3, { min: 1, max: 100 }),
    signal: input.int('Signal', 10, { min: 1, max: 100 }),
  },
  outputs: {
    smi: output.line('SMI', HT.info),
    signal: output.line('Signal', HT.warning, { width: 1 }),
  },
  guides: () => [-40, 40],
  title: (p) => `SMI ${p.k} ${p.d} ${p.smooth}`,
  calc(ctx) {
    const i = ctx.i;
    const hh = highest(ctx.src('high'), i, ctx.inputs.k);
    const ll = lowest(ctx.src('low'), i, ctx.inputs.k);
    const m = ctx.buf('m');
    const rg = ctx.buf('rg');
    m[i] = ctx.bar.c - (hh + ll) / 2;
    rg[i] = hh - ll;
    const m1 = ctx.buf('m1');
    const m2 = ctx.buf('m2');
    const r1 = ctx.buf('r1');
    const r2 = ctx.buf('r2');
    m1[i] = ema(m1, m, i, ctx.inputs.d);
    m2[i] = ema(m2, m1, i, ctx.inputs.smooth);
    r1[i] = ema(r1, rg, i, ctx.inputs.d);
    r2[i] = ema(r2, r1, i, ctx.inputs.smooth);
    const o = ctx.out.smi.v;
    o[i] = r2[i]! > 0 ? (100 * m2[i]!) / (0.5 * r2[i]!) : NaN_;
    ctx.out.signal.set(i, ema(ctx.out.signal.v, o, i, ctx.inputs.signal));
  },
});

export const QQE = defineIndicator({
  id: 'qqe',
  name: 'Quantitative Qualitative Estimation (QQE)',
  short: 'QQE',
  ...osc,
  description: 'Smoothed RSI with a volatility-adaptive trailing line (the RSI ATR).',
  formula:
    'R = EMA(RSI, sf); ΔR = |R₋ − R|; dar = f·EMA(EMA(ΔR, 2n−1), 2n−1); trailing long / short bands of R ± dar',
  range: [0, 100],
  inputs: {
    rsi: input.int('RSI period', 14, { min: 2, max: 200 }),
    smooth: input.int('Smoothing', 5, { min: 1, max: 100 }),
    factor: input.float('Factor', 4.236, { min: 0.5, max: 10, step: 0.1 }),
    source: input.source('Source', 'close'),
  },
  outputs: {
    rsi: output.line('RSI MA', HT.info),
    trail: output.line('Trailing line', HT.warning, { width: 1 }),
  },
  guides: () => [30, 50, 70],
  title: (p) => `QQE ${p.rsi} ${p.smooth} ${p.factor}${srcLabel(p.source)}`,
  calc(ctx) {
    const { rsi, smooth, factor } = ctx.inputs;
    const i = ctx.i;
    const raw = rsiOf(ctx as unknown as AnyCtx, ctx.src(ctx.inputs.source), rsi, 'q');
    const rr = ctx.buf('rr');
    rr[i] = raw;
    const ma = ctx.out.rsi.v;
    ma[i] = ema(ma, rr, i, smooth);
    const dr = ctx.buf('dr');
    if (i > 0) dr[i] = Math.abs(ma[i - 1]! - ma[i]!);
    const w = 2 * rsi - 1;
    const e1 = ctx.buf('e1');
    const e2 = ctx.buf('e2');
    e1[i] = ema(e1, dr, i, w);
    e2[i] = ema(e2, e1, i, w);
    const dar = e2[i]! * factor;
    const lb = ctx.buf('lb');
    const sb = ctx.buf('sb');
    const tr = ctx.buf('tr');
    const v = ma[i]!;
    if (Number.isNaN(v + dar)) return;
    const pl = i > 0 ? lb[i - 1]! : NaN_;
    const ps = i > 0 ? sb[i - 1]! : NaN_;
    const pv = i > 0 ? ma[i - 1]! : NaN_;
    const nl = v - dar;
    const ns = v + dar;
    lb[i] = !Number.isNaN(pl) && pv > pl && v > pl ? Math.max(pl, nl) : nl;
    sb[i] = !Number.isNaN(ps) && pv < ps && v < ps ? Math.min(ps, ns) : ns;
    const pt = i > 0 && !Number.isNaN(tr[i - 1]!) ? tr[i - 1]! : 1;
    tr[i] =
      !Number.isNaN(ps) && pv <= ps && v > ps
        ? 1
        : !Number.isNaN(pl) && pv >= pl && v < pl
          ? -1
          : pt;
    ctx.out.trail.set(i, tr[i] === 1 ? lb[i]! : sb[i]!);
  },
});

export const WaveTrend = defineIndicator({
  id: 'wavetrend',
  name: 'WaveTrend Oscillator',
  short: 'WT',
  ...osc,
  description: "LazyBear's WaveTrend: a channel-index oscillator with a signal line and histogram.",
  formula:
    'AP = HLC3; ESA = EMA(AP, c); D = EMA(|AP − ESA|, c); CI = (AP − ESA)/(0.015·D); WT1 = EMA(CI, a); WT2 = SMA(WT1, 4)',
  zeroLine: true,
  inputs: {
    channel: input.int('Channel length', 10, { min: 1, max: 200 }),
    average: input.int('Average length', 21, { min: 1, max: 200 }),
  },
  outputs: {
    hist: output.histogram('WT1 − WT2', HT.up, { color2: HT.down, opacity: 0.5, legend: false }),
    wt1: output.line('WT1', HT.info),
    wt2: output.line('WT2', HT.warning, { width: 1 }),
  },
  guides: () => [-60, 60],
  title: (p) => `WaveTrend ${p.channel} ${p.average}`,
  calc(ctx) {
    const i = ctx.i;
    const ap = ctx.src('hlc3');
    const esa = ctx.buf('esa');
    esa[i] = ema(esa, ap, i, ctx.inputs.channel);
    const ad = ctx.buf('ad');
    ad[i] = Math.abs(ap[i]! - esa[i]!);
    const d = ctx.buf('d');
    d[i] = ema(d, ad, i, ctx.inputs.channel);
    const ci = ctx.buf('ci');
    ci[i] = d[i]! > 0 ? (ap[i]! - esa[i]!) / (0.015 * d[i]!) : Number.isNaN(d[i]!) ? NaN_ : 0;
    const w1 = ctx.out.wt1.v;
    w1[i] = ema(w1, ci, i, ctx.inputs.average);
    const w2 = ctx.out.wt2.v;
    w2[i] = sma(w1, i, 4);
    const h = w1[i]! - w2[i]!;
    if (!Number.isNaN(h)) ctx.out.hist.set(i, h, h >= 0 ? 0 : 1);
  },
});

export const AdaptiveRSI = defineIndicator({
  id: 'adaptive-rsi',
  name: 'Adaptive RSI',
  short: 'ARSI',
  ...osc,
  description:
    'RSI whose smoothing period adapts to the efficiency ratio: faster in trends, slower in chop.',
  formula:
    'ER = |x − x[n]| / Σ|Δx|; period = max − ER·(max − min); gains and losses are EMA-smoothed with α = 2/(period+1); RSI = 100 − 100/(1 + G/L)',
  range: [0, 100],
  inputs: {
    er: input.int('Efficiency period', 10, { min: 2, max: 200 }),
    min: input.int('Fastest period', 5, { min: 2, max: 100 }),
    max: input.int('Slowest period', 30, { min: 3, max: 500 }),
    source: input.source('Source', 'close'),
  },
  outputs: { rsi: output.line('ARSI', HT.special) },
  guides: () => [30, 50, 70],
  title: (p) => `Adaptive RSI ${p.er} ${p.min}-${p.max}${srcLabel(p.source)}`,
  calc(ctx) {
    const { er: n, min, max } = ctx.inputs;
    const i = ctx.i;
    const s = ctx.src(ctx.inputs.source);
    if (i < n) return;
    let vol = 0;
    for (let k = i - n + 1; k <= i; k++) vol += Math.abs(s[k]! - s[k - 1]!);
    const eff = vol > 0 ? Math.abs(s[i]! - s[i - n]!) / vol : 0;
    const per = Math.max(min, max - eff * (max - min));
    const a = 2 / (per + 1);
    const d = s[i]! - s[i - 1]!;
    const ag = ctx.buf('ag');
    const al = ctx.buf('al');
    const pg = Number.isNaN(ag[i - 1]!) ? 0 : ag[i - 1]!;
    const pl = Number.isNaN(al[i - 1]!) ? 0 : al[i - 1]!;
    ag[i] = pg + a * (Math.max(0, d) - pg);
    al[i] = pl + a * (Math.max(0, -d) - pl);
    ctx.out.rsi.set(i, al[i] === 0 ? (ag[i] === 0 ? 50 : 100) : 100 - 100 / (1 + ag[i]! / al[i]!));
  },
});
