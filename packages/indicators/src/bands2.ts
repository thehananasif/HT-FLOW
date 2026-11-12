import {
  HT,
  defineIndicator,
  highest,
  input,
  linreg,
  lowest,
  output,
  rma,
  sma,
  stdev,
  trueRange,
} from '@htflow/indicator-sdk';
import { srcLabel } from './common';

const band = { category: 'technical' as const, group: 'Bands & channels' };
const NaN_ = Number.NaN;

/** Sum of squared residuals of the least-squares line over the last n values. */
function residualSS(
  src: ArrayLike<number>,
  i: number,
  n: number,
  lr: { slope: number; intercept: number },
): number {
  let ss = 0;
  for (let k = 0; k < n; k++) {
    const e = src[i - n + 1 + k]! - (lr.intercept + lr.slope * k);
    ss += e * e;
  }
  return ss;
}

export const BollingerSqueeze = defineIndicator({
  id: 'bb-squeeze',
  name: 'Bollinger Squeeze (V2 / V3)',
  short: 'Squeeze',
  ...band,
  pane: 'new',
  description:
    'Squeeze Momentum: dots mark when the Bollinger Bands sit inside the Keltner Channel (volatility compression); the histogram is the linear-regression momentum. V3 adds a tight squeeze (Keltner ×1.0) next to the normal one (×1.5).',
  formula:
    'Squeeze when BB(n, k) ⊂ KC(SMA(n) ± m·SMA(TR, n)); momentum = linreg(C − ((HH + LL)/2 + SMA(C))/2, n)',
  zeroLine: true,
  inputs: {
    version: input.enum('Version', 'v2', [
      ['v2', 'V2 (on / off)'],
      ['v3', 'V3 (normal + tight)'],
    ]),
    period: input.int('Period', 20, { min: 2, max: 500 }),
    bbMult: input.float('BB multiplier', 2, { min: 0.1, max: 10, step: 0.1 }),
    kcMult: input.float('KC multiplier', 1.5, { min: 0.1, max: 10, step: 0.1 }),
  },
  outputs: {
    mom: output.histogram('Momentum', HT.up, { color2: HT.down, opacity: 0.75 }),
    sqz: output.dots('Squeeze', HT.up, {
      color2: HT.warning,
      color3: HT.down,
      width: 3,
      legend: false,
    }),
  },
  title: (p) => `Squeeze ${p.version} ${p.period}`,
  calc(ctx) {
    const { period: n, bbMult, kcMult } = ctx.inputs;
    const i = ctx.i;
    const c = ctx.src('close');
    const tr = ctx.buf('tr');
    tr[i] = trueRange(ctx.bar.h, ctx.bar.l, i > 0 ? ctx.bars[i - 1]!.c : NaN_);
    const basis = sma(c, i, n);
    const sd = stdev(c, i, n);
    const range = sma(tr, i, n);
    const d = ctx.buf('d');
    d[i] =
      c[i]! - ((highest(ctx.src('high'), i, n) + lowest(ctx.src('low'), i, n)) / 2 + basis) / 2;
    if (Number.isNaN(basis + sd + range)) return;
    const bbHalf = bbMult * sd;
    const on = (m: number) => bbHalf < m * range;
    const state =
      ctx.inputs.version === 'v3' ? (on(1) ? 2 : on(kcMult) ? 1 : 0) : on(kcMult) ? 1 : 0;
    ctx.out.sqz.set(i, 0, state === 0 ? 0 : state === 1 ? 1 : 2);
    const lr = linreg(d, i, n);
    if (!Number.isNaN(lr.value)) ctx.out.mom.set(i, lr.value, lr.value >= 0 ? 0 : 1);
  },
});

export const Starc = defineIndicator({
  id: 'starc',
  name: 'Starc Bands',
  short: 'Starc',
  ...band,
  pane: 'overlay',
  description: 'Stoller Average Range Channels: a short SMA with bands of a longer ATR.',
  formula: 'Mid = SMA(C, n); Upper/Lower = Mid ± k·ATR(m)',
  inputs: {
    period: input.int('SMA period', 6, { min: 1, max: 500 }),
    atr: input.int('ATR period', 15, { min: 1, max: 500 }),
    mult: input.float('Multiplier', 2, { min: 0.1, max: 10, step: 0.1 }),
    source: input.source('Source', 'close'),
  },
  outputs: {
    upper: output.line('Upper', HT.down, { unit: 'price', width: 1 }),
    mid: output.line('Mid', HT.soft, { unit: 'price', width: 1 }),
    lower: output.line('Lower', HT.up, { unit: 'price', width: 1 }),
  },
  title: (p) => `Starc ${p.period} ${p.atr} ${p.mult}${srcLabel(p.source)}`,
  calc(ctx) {
    const i = ctx.i;
    const tr = ctx.buf('tr');
    tr[i] = trueRange(ctx.bar.h, ctx.bar.l, i > 0 ? ctx.bars[i - 1]!.c : NaN_);
    const atr = ctx.buf('atr');
    atr[i] = rma(atr, tr, i, ctx.inputs.atr);
    const m = sma(ctx.src(ctx.inputs.source), i, ctx.inputs.period);
    ctx.out.mid.set(i, m);
    ctx.out.upper.set(i, m + ctx.inputs.mult * atr[i]!);
    ctx.out.lower.set(i, m - ctx.inputs.mult * atr[i]!);
  },
});

export const ATRBands = defineIndicator({
  id: 'atr-bands',
  name: 'ATR Bands',
  short: 'ATR Bands',
  ...band,
  pane: 'overlay',
  description: 'Bands at a multiple of the ATR above and below the price itself.',
  formula: 'Upper = x + k·ATR(n); Lower = x − k·ATR(n)',
  inputs: {
    period: input.int('ATR period', 14, { min: 1, max: 500 }),
    mult: input.float('Multiplier', 2, { min: 0.1, max: 20, step: 0.1 }),
    source: input.source('Source', 'close'),
  },
  outputs: {
    upper: output.line('Upper', HT.down, { unit: 'price', width: 1 }),
    lower: output.line('Lower', HT.up, { unit: 'price', width: 1 }),
  },
  title: (p) => `ATR Bands ${p.period} ${p.mult}${srcLabel(p.source)}`,
  calc(ctx) {
    const i = ctx.i;
    const tr = ctx.buf('tr');
    tr[i] = trueRange(ctx.bar.h, ctx.bar.l, i > 0 ? ctx.bars[i - 1]!.c : NaN_);
    const atr = ctx.buf('atr');
    atr[i] = rma(atr, tr, i, ctx.inputs.period);
    const x = ctx.src(ctx.inputs.source)[i]!;
    ctx.out.upper.set(i, x + ctx.inputs.mult * atr[i]!);
    ctx.out.lower.set(i, x - ctx.inputs.mult * atr[i]!);
  },
});

export const StdErrBands = defineIndicator({
  id: 'stderr-bands',
  name: 'Standard Error Bands',
  short: 'SE Bands',
  ...band,
  pane: 'overlay',
  description: 'Linear-regression line with bands at k standard errors of the estimate.',
  formula: 'SE = √(Σ(y − ŷ)² / (n − 2)); Upper/Lower = LinReg(n) ± k·SE',
  inputs: {
    period: input.int('Period', 21, { min: 3, max: 1000 }),
    mult: input.float('Multiplier', 2, { min: 0.1, max: 10, step: 0.1 }),
    source: input.source('Source', 'close'),
  },
  outputs: {
    upper: output.line('Upper', HT.down, { unit: 'price', width: 1 }),
    mid: output.line('LinReg', HT.soft, { unit: 'price', width: 1 }),
    lower: output.line('Lower', HT.up, { unit: 'price', width: 1 }),
  },
  title: (p) => `SE Bands ${p.period} ${p.mult}${srcLabel(p.source)}`,
  calc(ctx) {
    const { period: n, mult } = ctx.inputs;
    const s = ctx.src(ctx.inputs.source);
    const lr = linreg(s, ctx.i, n);
    if (Number.isNaN(lr.value)) return;
    const se = Math.sqrt(residualSS(s, ctx.i, n, lr) / (n - 2));
    ctx.out.mid.set(ctx.i, lr.value);
    ctx.out.upper.set(ctx.i, lr.value + mult * se);
    ctx.out.lower.set(ctx.i, lr.value - mult * se);
  },
});

export const LinRegChannel = defineIndicator({
  id: 'linreg-channel',
  name: 'Linear Regression Channel',
  short: 'LinReg Ch',
  ...band,
  pane: 'overlay',
  description:
    'Least-squares line over the last n bars with parallel bands at k standard deviations of the residuals.',
  formula: 'σ = √(Σ(y − ŷ)² / n); Mid = LinReg(n); Upper/Lower = Mid ± k·σ',
  inputs: {
    period: input.int('Period', 100, { min: 3, max: 2000 }),
    mult: input.float('Deviations', 2, { min: 0.1, max: 10, step: 0.1 }),
    source: input.source('Source', 'close'),
  },
  outputs: {
    upper: output.line('Upper', HT.down, { unit: 'price', width: 1 }),
    mid: output.line('Mid', HT.warning, { unit: 'price', width: 1.5 }),
    lower: output.line('Lower', HT.up, { unit: 'price', width: 1 }),
  },
  title: (p) => `LinReg Channel ${p.period} ${p.mult}${srcLabel(p.source)}`,
  calc(ctx) {
    const { period: n, mult } = ctx.inputs;
    const s = ctx.src(ctx.inputs.source);
    const lr = linreg(s, ctx.i, n);
    if (Number.isNaN(lr.value)) return;
    const sd = Math.sqrt(residualSS(s, ctx.i, n, lr) / n);
    ctx.out.mid.set(ctx.i, lr.value);
    ctx.out.upper.set(ctx.i, lr.value + mult * sd);
    ctx.out.lower.set(ctx.i, lr.value - mult * sd);
  },
});

function linregPart(
  id: string,
  name: string,
  short: string,
  formula: string,
  pick: (r: ReturnType<typeof linreg>) => number,
  range?: [number, number],
) {
  return defineIndicator({
    id,
    name,
    short,
    ...band,
    pane: 'new',
    description: `${name} of the least-squares line over the last n bars.`,
    formula,
    range,
    zeroLine: id === 'linreg-slope',
    inputs: {
      period: input.int('Period', 14, { min: 2, max: 2000 }),
      source: input.source('Source', 'close'),
    },
    outputs: { v: output.line(short, HT.info) },
    title: (p) => `${short} ${p.period}${srcLabel(p.source)}`,
    calc(ctx) {
      ctx.out.v.set(ctx.i, pick(linreg(ctx.src(ctx.inputs.source), ctx.i, ctx.inputs.period)));
    },
  });
}

export const LinRegSlope = linregPart(
  'linreg-slope',
  'Linear Regression Slope',
  'LR Slope',
  'slope = (nΣxy − ΣxΣy) / (nΣx² − (Σx)²) per bar (price in ticks)',
  (r) => r.slope,
);
export const LinRegIntercept = linregPart(
  'linreg-intercept',
  'Linear Regression Intercept',
  'LR Intercept',
  'intercept = (Σy − slope·Σx) / n: the line value at the first bar of the window',
  (r) => r.intercept,
);
export const LinRegR2 = linregPart(
  'linreg-r2',
  'Linear Regression R²',
  'LR R²',
  'R² = (nΣxy − ΣxΣy)² / ((nΣx² − (Σx)²)(nΣy² − (Σy)²))',
  (r) => r.r2,
  [0, 1],
);
