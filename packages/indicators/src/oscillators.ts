import {
  HT,
  defineIndicator,
  ema,
  highest,
  input,
  lowest,
  meanDev,
  output,
  rma,
  sma,
  sum,
} from '@htflow/indicator-sdk';
import { srcLabel } from './common';

const osc = {
  category: 'technical' as const,
  group: 'Momentum & oscillators',
  pane: 'new' as const,
};

export const RSI = defineIndicator({
  id: 'rsi',
  name: 'Relative Strength Index',
  short: 'RSI',
  ...osc,
  description: "Wilder's RSI.",
  formula: 'RS = RMA(gain, n) / RMA(loss, n); RSI = 100 − 100 / (1 + RS)',
  range: [0, 100],
  inputs: {
    period: input.int('Period', 14, { min: 1, max: 500 }),
    source: input.source('Source', 'close', { help: 'Try "Cumulative delta" for RSI of CVD.' }),
    ob: input.int('Overbought', 70, { min: 50, max: 100 }),
    os: input.int('Oversold', 30, { min: 0, max: 50 }),
  },
  outputs: { rsi: output.line('RSI', HT.special) },
  guides: (p) => [p.os, 50, p.ob],
  title: (p) => `RSI ${p.period}${srcLabel(p.source)}`,
  calc(ctx) {
    const s = ctx.src(ctx.inputs.source);
    const g = ctx.buf('g');
    const l = ctx.buf('l');
    if (ctx.i > 0) {
      const d = s[ctx.i]! - s[ctx.i - 1]!;
      g[ctx.i] = Math.max(0, d);
      l[ctx.i] = Math.max(0, -d);
    }
    const ag = ctx.buf('ag');
    const al = ctx.buf('al');
    ag[ctx.i] = rma(ag, g, ctx.i, ctx.inputs.period);
    al[ctx.i] = rma(al, l, ctx.i, ctx.inputs.period);
    const a = ag[ctx.i]!;
    const b = al[ctx.i]!;
    ctx.out.rsi.set(
      ctx.i,
      Number.isNaN(a) ? a : b === 0 ? (a === 0 ? 50 : 100) : 100 - 100 / (1 + a / b),
    );
  },
});

export const Stochastic = defineIndicator({
  id: 'stochastic',
  name: 'Stochastic',
  short: 'Stoch',
  ...osc,
  description: 'Close relative to the high-low range, smoothed.',
  formula: '%K = SMA(100·(C − LL)/(HH − LL), smooth); %D = SMA(%K, d)',
  range: [0, 100],
  inputs: {
    k: input.int('%K period', 14, { min: 1, max: 500 }),
    smooth: input.int('%K smoothing', 3, { min: 1, max: 50 }),
    d: input.int('%D period', 3, { min: 1, max: 50 }),
  },
  outputs: { k: output.line('%K', HT.info), d: output.line('%D', HT.warning) },
  guides: () => [20, 80],
  title: (p) => `Stoch ${p.k} ${p.smooth} ${p.d}`,
  calc(ctx) {
    const hh = highest(ctx.src('high'), ctx.i, ctx.inputs.k);
    const ll = lowest(ctx.src('low'), ctx.i, ctx.inputs.k);
    const raw = ctx.buf('raw');
    raw[ctx.i] = hh > ll ? (100 * (ctx.bar.c - ll)) / (hh - ll) : Number.isNaN(hh) ? hh : 50;
    const k = ctx.out.k.v;
    k[ctx.i] = sma(raw, ctx.i, ctx.inputs.smooth);
    ctx.out.d.set(ctx.i, sma(k, ctx.i, ctx.inputs.d));
  },
});

export const StochRSI = defineIndicator({
  id: 'stoch-rsi',
  name: 'Stochastic RSI',
  short: 'StochRSI',
  ...osc,
  description: 'Stochastic applied to RSI values.',
  formula: 'raw = 100·(RSI − min(RSI,n))/(max − min); K = SMA(raw,k); D = SMA(K,d)',
  range: [0, 100],
  inputs: {
    rsi: input.int('RSI period', 14, { min: 1, max: 500 }),
    stoch: input.int('Stochastic period', 14, { min: 1, max: 500 }),
    k: input.int('K', 3, { min: 1, max: 50 }),
    d: input.int('D', 3, { min: 1, max: 50 }),
    source: input.source('Source', 'close'),
  },
  outputs: { k: output.line('K', HT.info), d: output.line('D', HT.warning) },
  guides: () => [20, 80],
  title: (p) => `StochRSI ${p.rsi} ${p.stoch}`,
  calc(ctx) {
    const s = ctx.src(ctx.inputs.source);
    const g = ctx.buf('g');
    const l = ctx.buf('l');
    if (ctx.i > 0) {
      const d = s[ctx.i]! - s[ctx.i - 1]!;
      g[ctx.i] = Math.max(0, d);
      l[ctx.i] = Math.max(0, -d);
    }
    const ag = ctx.buf('ag');
    const al = ctx.buf('al');
    ag[ctx.i] = rma(ag, g, ctx.i, ctx.inputs.rsi);
    al[ctx.i] = rma(al, l, ctx.i, ctx.inputs.rsi);
    const rsi = ctx.buf('rsi');
    const a = ag[ctx.i]!;
    const b = al[ctx.i]!;
    rsi[ctx.i] = Number.isNaN(a) ? a : b === 0 ? 100 : 100 - 100 / (1 + a / b);
    const hh = highest(rsi, ctx.i, ctx.inputs.stoch);
    const ll = lowest(rsi, ctx.i, ctx.inputs.stoch);
    const raw = ctx.buf('raw');
    raw[ctx.i] = hh > ll ? (100 * (rsi[ctx.i]! - ll)) / (hh - ll) : Number.isNaN(hh) ? hh : 0;
    const k = ctx.out.k.v;
    k[ctx.i] = sma(raw, ctx.i, ctx.inputs.k);
    ctx.out.d.set(ctx.i, sma(k, ctx.i, ctx.inputs.d));
  },
});

export const MACD = defineIndicator({
  id: 'macd',
  name: 'MACD + Histogram',
  short: 'MACD',
  ...osc,
  description: 'Difference of two EMAs, its signal EMA and the histogram.',
  formula: 'MACD = EMA(fast) − EMA(slow); Signal = EMA(MACD, s); Hist = MACD − Signal',
  zeroLine: true,
  inputs: {
    fast: input.int('Fast', 12, { min: 1, max: 500 }),
    slow: input.int('Slow', 26, { min: 1, max: 500 }),
    signal: input.int('Signal', 9, { min: 1, max: 500 }),
    source: input.source('Source', 'close'),
  },
  outputs: {
    hist: output.histogram('Histogram', HT.up, { color2: HT.down, opacity: 0.7, unit: 'price' }),
    macd: output.line('MACD', HT.info, { unit: 'price' }),
    signal: output.line('Signal', HT.warning, { unit: 'price' }),
  },
  title: (p) => `MACD ${p.fast} ${p.slow} ${p.signal}`,
  calc(ctx) {
    const s = ctx.src(ctx.inputs.source);
    const f = ctx.buf('f');
    const sl = ctx.buf('s');
    f[ctx.i] = ema(f, s, ctx.i, ctx.inputs.fast);
    sl[ctx.i] = ema(sl, s, ctx.i, ctx.inputs.slow);
    const m = ctx.out.macd.v;
    m[ctx.i] = f[ctx.i]! - sl[ctx.i]!;
    const sg = ctx.out.signal.v;
    sg[ctx.i] = ema(sg, m, ctx.i, ctx.inputs.signal);
    const h = m[ctx.i]! - sg[ctx.i]!;
    ctx.out.hist.set(ctx.i, h, h >= 0 ? 0 : 1);
  },
});

export const CCI = defineIndicator({
  id: 'cci',
  name: 'Commodity Channel Index',
  short: 'CCI',
  ...osc,
  description: 'Deviation of the typical price from its SMA, scaled by mean deviation.',
  formula: 'CCI = (TP − SMA(TP)) / (0.015 · MeanDev(TP))',
  inputs: {
    period: input.int('Period', 20, { min: 2, max: 500 }),
    source: input.source('Source', 'hlc3'),
  },
  outputs: { cci: output.line('CCI', HT.info) },
  guides: () => [-100, 0, 100],
  title: (p) => `CCI ${p.period}`,
  calc(ctx) {
    const s = ctx.src(ctx.inputs.source);
    const md = meanDev(s, ctx.i, ctx.inputs.period);
    const m = sma(s, ctx.i, ctx.inputs.period);
    ctx.out.cci.set(ctx.i, md > 0 ? (s[ctx.i]! - m) / (0.015 * md) : Number.isNaN(md) ? md : 0);
  },
});

export const WilliamsR = defineIndicator({
  id: 'williams-r',
  name: 'Williams %R',
  short: '%R',
  ...osc,
  description: 'Close relative to the n-bar range, from −100 to 0.',
  formula: '%R = −100 · (HH − C) / (HH − LL)',
  range: [-100, 0],
  inputs: { period: input.int('Period', 14, { min: 1, max: 500 }) },
  outputs: { r: output.line('%R', HT.special) },
  guides: () => [-80, -20],
  title: (p) => `%R ${p.period}`,
  calc(ctx) {
    const hh = highest(ctx.src('high'), ctx.i, ctx.inputs.period);
    const ll = lowest(ctx.src('low'), ctx.i, ctx.inputs.period);
    ctx.out.r.set(
      ctx.i,
      hh > ll ? (-100 * (hh - ctx.bar.c)) / (hh - ll) : Number.isNaN(hh) ? hh : -50,
    );
  },
});

export const ROC = defineIndicator({
  id: 'roc',
  name: 'Rate of Change',
  short: 'ROC',
  ...osc,
  description: 'Percentage change over n bars.',
  formula: 'ROC = 100 · (x − x[n]) / x[n]',
  zeroLine: true,
  inputs: {
    period: input.int('Period', 10, { min: 1, max: 500 }),
    source: input.source('Source', 'close'),
  },
  outputs: { roc: output.line('ROC', HT.info, { unit: 'percent' }) },
  title: (p) => `ROC ${p.period}${srcLabel(p.source)}`,
  calc(ctx) {
    const s = ctx.src(ctx.inputs.source);
    const n = ctx.inputs.period;
    if (ctx.i < n) return;
    const p = s[ctx.i - n]!;
    ctx.out.roc.set(ctx.i, p !== 0 ? (100 * (s[ctx.i]! - p)) / p : Number.NaN);
  },
});

export const Momentum = defineIndicator({
  id: 'momentum',
  name: 'Momentum',
  short: 'MOM',
  ...osc,
  description: 'Difference between the source and its value n bars ago.',
  formula: 'MOM = x − x[n]',
  zeroLine: true,
  inputs: {
    period: input.int('Period', 10, { min: 1, max: 500 }),
    source: input.source('Source', 'close'),
  },
  outputs: { mom: output.line('Momentum', HT.info, { unit: 'price' }) },
  title: (p) => `MOM ${p.period}${srcLabel(p.source)}`,
  calc(ctx) {
    const s = ctx.src(ctx.inputs.source);
    if (ctx.i >= ctx.inputs.period)
      ctx.out.mom.set(ctx.i, s[ctx.i]! - s[ctx.i - ctx.inputs.period]!);
  },
});

export const Awesome = defineIndicator({
  id: 'awesome',
  name: 'Awesome Oscillator',
  short: 'AO',
  ...osc,
  description: 'SMA(5) − SMA(34) of the median price, coloured by change.',
  formula: 'AO = SMA(HL2, 5) − SMA(HL2, 34)',
  zeroLine: true,
  inputs: {
    fast: input.int('Fast', 5, { min: 1, max: 200 }),
    slow: input.int('Slow', 34, { min: 2, max: 500 }),
  },
  outputs: { ao: output.histogram('AO', HT.up, { color2: HT.down, unit: 'price' }) },
  title: (p) => `AO ${p.fast} ${p.slow}`,
  calc(ctx) {
    const s = ctx.src('hl2');
    const v = sma(s, ctx.i, ctx.inputs.fast) - sma(s, ctx.i, ctx.inputs.slow);
    const p = ctx.out.ao.get(ctx.i - 1);
    ctx.out.ao.set(ctx.i, v, Number.isNaN(p) || v >= p ? 0 : 1);
  },
});

export const CMO = defineIndicator({
  id: 'cmo',
  name: 'Chande Momentum Oscillator',
  short: 'CMO',
  ...osc,
  description: 'Sum of up moves minus down moves over their total.',
  formula: 'CMO = 100 · (ΣU − ΣD) / (ΣU + ΣD)',
  range: [-100, 100],
  zeroLine: true,
  inputs: {
    period: input.int('Period', 14, { min: 1, max: 500 }),
    source: input.source('Source', 'close'),
  },
  outputs: { cmo: output.line('CMO', HT.info) },
  title: (p) => `CMO ${p.period}`,
  calc(ctx) {
    const s = ctx.src(ctx.inputs.source);
    const u = ctx.buf('u');
    const d = ctx.buf('d');
    if (ctx.i > 0) {
      const x = s[ctx.i]! - s[ctx.i - 1]!;
      u[ctx.i] = Math.max(0, x);
      d[ctx.i] = Math.max(0, -x);
    }
    const su = sum(u, ctx.i, ctx.inputs.period);
    const sd = sum(d, ctx.i, ctx.inputs.period);
    ctx.out.cmo.set(ctx.i, su + sd > 0 ? (100 * (su - sd)) / (su + sd) : Number.isNaN(su) ? su : 0);
  },
});

export const TRIX = defineIndicator({
  id: 'trix',
  name: 'TRIX',
  short: 'TRIX',
  ...osc,
  description: 'Rate of change of a triple-smoothed EMA.',
  formula: 'TRIX = 100 · (E3 − E3₋₁) / E3₋₁, E3 = EMA(EMA(EMA(x)))',
  zeroLine: true,
  inputs: {
    period: input.int('Period', 15, { min: 1, max: 500 }),
    source: input.source('Source', 'close'),
  },
  outputs: { trix: output.line('TRIX', HT.info, { unit: 'percent' }) },
  title: (p) => `TRIX ${p.period}`,
  calc(ctx) {
    const n = ctx.inputs.period;
    const e1 = ctx.buf('e1');
    const e2 = ctx.buf('e2');
    const e3 = ctx.buf('e3');
    e1[ctx.i] = ema(e1, ctx.src(ctx.inputs.source), ctx.i, n);
    e2[ctx.i] = ema(e2, e1, ctx.i, n);
    e3[ctx.i] = ema(e3, e2, ctx.i, n);
    if (ctx.i > 0) ctx.out.trix.set(ctx.i, (100 * (e3[ctx.i]! - e3[ctx.i - 1]!)) / e3[ctx.i - 1]!);
  },
});

export const ZScore = defineIndicator({
  id: 'zscore',
  name: 'Z-Score',
  short: 'Z',
  category: 'technical',
  group: 'Misc',
  pane: 'new',
  description: 'Distance of the source from its mean in standard deviations.',
  formula: 'Z = (x − SMA(n)) / σ(n)',
  zeroLine: true,
  inputs: {
    period: input.int('Period', 20, { min: 2, max: 1000 }),
    source: input.source('Source', 'close'),
  },
  outputs: { z: output.line('Z', HT.info) },
  guides: () => [-2, 2],
  title: (p) => `Z ${p.period}${srcLabel(p.source)}`,
  calc(ctx) {
    const s = ctx.src(ctx.inputs.source);
    const m = sma(s, ctx.i, ctx.inputs.period);
    let v = 0;
    for (let k = ctx.i - ctx.inputs.period + 1; k <= ctx.i && k >= 0; k++) v += (s[k]! - m) ** 2;
    const sd = Math.sqrt(v / ctx.inputs.period);
    ctx.out.z.set(ctx.i, sd > 0 ? (s[ctx.i]! - m) / sd : Number.isNaN(m) ? m : 0);
  },
});

export const BalanceOfPower = defineIndicator({
  id: 'bop',
  name: 'Balance of Power',
  short: 'BOP',
  ...osc,
  description: 'Close − open relative to the bar range, smoothed.',
  formula: 'BOP = SMA((C − O) / (H − L), n)',
  range: [-1, 1],
  zeroLine: true,
  inputs: { period: input.int('Smoothing', 14, { min: 1, max: 500 }) },
  outputs: { bop: output.line('BOP', HT.info) },
  title: (p) => `BOP ${p.period}`,
  calc(ctx) {
    const raw = ctx.buf('raw');
    const b = ctx.bar;
    raw[ctx.i] = b.h > b.l ? (b.c - b.o) / (b.h - b.l) : 0;
    ctx.out.bop.set(ctx.i, sma(raw, ctx.i, ctx.inputs.period));
  },
});
