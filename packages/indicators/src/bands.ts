import {
  HT,
  defineIndicator,
  ema,
  highest,
  input,
  lowest,
  output,
  rma,
  sma,
  stdev,
  trueRange,
} from '@htflow/indicator-sdk';
import { srcLabel } from './common';

const bbInputs = {
  period: input.int('Period', 20, { min: 2, max: 1000 }),
  mult: input.float('StdDev multiplier', 2, {
    min: 0.1,
    max: 10,
    step: 0.1,
    help: 'Band width in population standard deviations.',
  }),
  source: input.source('Source', 'close'),
};

export const Bollinger = defineIndicator({
  id: 'bollinger',
  name: 'Bollinger Bands',
  short: 'BB',
  category: 'technical',
  group: 'Bands & channels',
  pane: 'overlay',
  description: 'SMA with bands k standard deviations above and below.',
  formula: 'Basis = SMA(n); Upper/Lower = Basis ± k·σ(n)',
  inputs: bbInputs,
  outputs: {
    fill: output.band('Fill', HT.info, { opacity: 1, legend: false }),
    basis: output.line('Basis', HT.grey, { unit: 'price' }),
    upper: output.line('Upper', HT.info, { unit: 'price' }),
    lower: output.line('Lower', HT.info, { unit: 'price' }),
  },
  title: (p) => `BB ${p.period} ${p.mult}${srcLabel(p.source)}`,
  calc(ctx) {
    const s = ctx.src(ctx.inputs.source);
    const m = sma(s, ctx.i, ctx.inputs.period);
    const d = stdev(s, ctx.i, ctx.inputs.period) * ctx.inputs.mult;
    ctx.out.basis.set(ctx.i, m);
    ctx.out.upper.set(ctx.i, m + d);
    ctx.out.lower.set(ctx.i, m - d);
    ctx.out.fill.setPair(ctx.i, m + d, m - d);
  },
});

export const BollingerPctB = defineIndicator({
  id: 'bb-percent-b',
  name: 'Bollinger %B',
  short: '%B',
  category: 'technical',
  group: 'Bands & channels',
  pane: 'new',
  description: 'Position of the source within the Bollinger Bands (0 = lower, 1 = upper).',
  formula: '%B = (x − Lower) / (Upper − Lower)',
  inputs: bbInputs,
  outputs: { pb: output.line('%B', HT.info) },
  guides: () => [0, 1],
  title: (p) => `%B ${p.period} ${p.mult}`,
  calc(ctx) {
    const s = ctx.src(ctx.inputs.source);
    const m = sma(s, ctx.i, ctx.inputs.period);
    const d = stdev(s, ctx.i, ctx.inputs.period) * ctx.inputs.mult;
    ctx.out.pb.set(ctx.i, d > 0 ? (s[ctx.i]! - (m - d)) / (2 * d) : Number.NaN);
  },
});

export const BollingerBandwidth = defineIndicator({
  id: 'bb-bandwidth',
  name: 'Bollinger Bandwidth',
  short: 'BBW',
  category: 'technical',
  group: 'Bands & channels',
  pane: 'new',
  description: 'Width of the Bollinger Bands relative to the basis, in percent.',
  formula: 'BW = (Upper − Lower) / Basis · 100',
  inputs: bbInputs,
  outputs: { bw: output.line('Bandwidth', HT.info, { unit: 'percent' }) },
  title: (p) => `BBW ${p.period} ${p.mult}`,
  calc(ctx) {
    const s = ctx.src(ctx.inputs.source);
    const m = sma(s, ctx.i, ctx.inputs.period);
    const d = stdev(s, ctx.i, ctx.inputs.period) * ctx.inputs.mult;
    ctx.out.bw.set(ctx.i, m !== 0 ? ((2 * d) / m) * 100 : Number.NaN);
  },
});

export const StdDev = defineIndicator({
  id: 'stdev',
  name: 'Standard Deviation',
  short: 'StdDev',
  category: 'technical',
  group: 'Volatility',
  pane: 'new',
  description: 'Population standard deviation of the source.',
  formula: 'σ = √(Σ(x − mean)² / n)',
  inputs: {
    period: input.int('Period', 20, { min: 2, max: 1000 }),
    source: input.source('Source', 'close'),
  },
  outputs: { sd: output.line('StdDev', HT.soft, { unit: 'price' }) },
  title: (p) => `StdDev ${p.period}${srcLabel(p.source)}`,
  calc(ctx) {
    ctx.out.sd.set(ctx.i, stdev(ctx.src(ctx.inputs.source), ctx.i, ctx.inputs.period));
  },
});

export const ATR = defineIndicator({
  id: 'atr',
  name: 'Average True Range',
  short: 'ATR',
  category: 'technical',
  group: 'Volatility',
  pane: 'new',
  description: "Wilder's average of the true range.",
  formula: 'TR = max(H−L, |H−C₋₁|, |L−C₋₁|); ATR = RMA(TR, n)',
  inputs: { period: input.int('Period', 14, { min: 1, max: 500 }) },
  outputs: { atr: output.line('ATR', HT.soft, { unit: 'price' }) },
  title: (p) => `ATR ${p.period}`,
  calc(ctx) {
    const tr = ctx.buf('tr');
    const c = ctx.src('close');
    tr[ctx.i] = trueRange(ctx.bar.h, ctx.bar.l, ctx.i > 0 ? c[ctx.i - 1]! : Number.NaN);
    const o = ctx.out.atr.v;
    o[ctx.i] = rma(o, tr, ctx.i, ctx.inputs.period);
  },
});

export const Keltner = defineIndicator({
  id: 'keltner',
  name: 'Keltner Channels',
  short: 'KC',
  category: 'technical',
  group: 'Bands & channels',
  pane: 'overlay',
  description: 'EMA with bands at a multiple of the ATR.',
  formula: 'Basis = EMA(n); Upper/Lower = Basis ± k·ATR(m)',
  inputs: {
    period: input.int('EMA period', 20, { min: 1, max: 500 }),
    atrPeriod: input.int('ATR period', 10, { min: 1, max: 500 }),
    mult: input.float('ATR multiplier', 2, { min: 0.1, max: 10, step: 0.1 }),
    source: input.source('Source', 'close'),
  },
  outputs: {
    basis: output.line('Basis', HT.grey, { unit: 'price' }),
    upper: output.line('Upper', HT.special, { unit: 'price' }),
    lower: output.line('Lower', HT.special, { unit: 'price' }),
  },
  title: (p) => `KC ${p.period} ${p.mult}`,
  calc(ctx) {
    const b = ctx.out.basis.v;
    b[ctx.i] = ema(b, ctx.src(ctx.inputs.source), ctx.i, ctx.inputs.period);
    const tr = ctx.buf('tr');
    const c = ctx.src('close');
    tr[ctx.i] = trueRange(ctx.bar.h, ctx.bar.l, ctx.i > 0 ? c[ctx.i - 1]! : Number.NaN);
    const atr = ctx.buf('atr');
    atr[ctx.i] = rma(atr, tr, ctx.i, ctx.inputs.atrPeriod);
    const d = atr[ctx.i]! * ctx.inputs.mult;
    ctx.out.upper.set(ctx.i, b[ctx.i]! + d);
    ctx.out.lower.set(ctx.i, b[ctx.i]! - d);
  },
});

export const Donchian = defineIndicator({
  id: 'donchian',
  name: 'Donchian Channels',
  short: 'DC',
  category: 'technical',
  group: 'Bands & channels',
  pane: 'overlay',
  description: 'Highest high and lowest low of the last n bars, with the midline.',
  formula: 'Upper = max(H, n); Lower = min(L, n); Mid = (Upper + Lower) / 2',
  inputs: { period: input.int('Period', 20, { min: 1, max: 1000 }) },
  outputs: {
    upper: output.line('Upper', HT.info, { unit: 'price' }),
    mid: output.line('Mid', HT.grey, { unit: 'price', style: 'dashed' }),
    lower: output.line('Lower', HT.info, { unit: 'price' }),
  },
  title: (p) => `DC ${p.period}`,
  calc(ctx) {
    const u = highest(ctx.src('high'), ctx.i, ctx.inputs.period);
    const l = lowest(ctx.src('low'), ctx.i, ctx.inputs.period);
    ctx.out.upper.set(ctx.i, u);
    ctx.out.lower.set(ctx.i, l);
    ctx.out.mid.set(ctx.i, (u + l) / 2);
  },
});
