import {
  HT,
  defineIndicator,
  ema,
  input,
  linreg,
  output,
  rma,
  sma,
  wma,
  type CalcContext,
  type InputDefs,
  type OutputDefs,
} from '@htflow/indicator-sdk';
import { srcLabel } from './common';

const maInputs = (n: number) => ({
  period: input.int('Period', n, { min: 1, max: 1000, help: 'Number of bars averaged.' }),
  source: input.source('Source', 'close', {
    help: 'Value averaged per bar (price, volume, delta, CVD…).',
  }),
});

type MaIn = ReturnType<typeof maInputs>;
const maOut = (color: string) => ({ ma: output.line('MA', color, { unit: 'price' as const }) });
type MaOut = ReturnType<typeof maOut>;

function ma(
  id: string,
  short: string,
  name: string,
  formula: string,
  n: number,
  color: string,
  calc: (ctx: CalcContext<MaIn, MaOut>, src: Float64Array, out: Float64Array) => number,
) {
  return defineIndicator({
    id,
    name,
    short,
    category: 'technical',
    group: 'Moving averages',
    pane: 'overlay',
    description: `${name} of the selected source.`,
    formula,
    inputs: maInputs(n),
    outputs: maOut(color),
    title: (p) => `${short} ${p.period}${srcLabel(p.source)}`,
    calc(ctx) {
      const src = ctx.src(ctx.inputs.source);
      const out = ctx.out.ma.v;
      out[ctx.i] = calc(ctx, src, out);
    },
  });
}

export const SMA = ma('sma', 'SMA', 'Simple Moving Average', 'SMA = Σ x / n', 20, HT.info, (c, s) =>
  sma(s, c.i, c.inputs.period),
);
export const EMA = ma(
  'ema',
  'EMA',
  'Exponential Moving Average',
  'EMA = EMA₋₁ + α(x − EMA₋₁), α = 2/(n+1), seeded with SMA',
  21,
  HT.warning,
  (c, s, o) => ema(o, s, c.i, c.inputs.period),
);
export const WMA = ma(
  'wma',
  'WMA',
  'Weighted Moving Average',
  'WMA = Σ k·x_k / Σ k (k = 1…n)',
  20,
  HT.special,
  (c, s) => wma(s, c.i, c.inputs.period),
);
export const SMMA = ma(
  'smma',
  'SMMA',
  'Smoothed Moving Average (SMMA / RMA)',
  'Wilder: RMA = RMA₋₁ + (x − RMA₋₁)/n',
  14,
  HT.soft,
  (c, s, o) => rma(o, s, c.i, c.inputs.period),
);
export const LSMA = ma(
  'lsma',
  'LSMA',
  'Least Squares Moving Average',
  'End value of the least-squares line over n bars',
  25,
  HT.soft,
  (c, s) => linreg(s, c.i, c.inputs.period).value,
);

export const HMA = ma(
  'hma',
  'HMA',
  'Hull Moving Average',
  'HMA = WMA(2·WMA(n/2) − WMA(n), √n)',
  21,
  HT.info,
  (c, s) => {
    const n = c.inputs.period;
    const raw = c.buf('raw');
    raw[c.i] = 2 * wma(s, c.i, Math.max(1, Math.floor(n / 2))) - wma(s, c.i, n);
    return wma(raw, c.i, Math.max(1, Math.round(Math.sqrt(n))));
  },
);

export const DEMA = ma(
  'dema',
  'DEMA',
  'Double Exponential Moving Average',
  'DEMA = 2·EMA − EMA(EMA)',
  21,
  HT.warning,
  (c, s) => {
    const e1 = c.buf('e1');
    const e2 = c.buf('e2');
    const n = c.inputs.period;
    e1[c.i] = ema(e1, s, c.i, n);
    e2[c.i] = ema(e2, e1, c.i, n);
    return 2 * e1[c.i]! - e2[c.i]!;
  },
);

export const TEMA = ma(
  'tema',
  'TEMA',
  'Triple Exponential Moving Average',
  'TEMA = 3·E1 − 3·E2 + E3',
  21,
  HT.warning,
  (c, s) => {
    const e1 = c.buf('e1');
    const e2 = c.buf('e2');
    const e3 = c.buf('e3');
    const n = c.inputs.period;
    e1[c.i] = ema(e1, s, c.i, n);
    e2[c.i] = ema(e2, e1, c.i, n);
    e3[c.i] = ema(e3, e2, c.i, n);
    return 3 * e1[c.i]! - 3 * e2[c.i]! + e3[c.i]!;
  },
);

export const ZLEMA = ma(
  'zlema',
  'ZLEMA',
  'Zero-Lag EMA',
  'ZLEMA = EMA(x + (x − x[lag]), n), lag = (n−1)/2',
  21,
  HT.warning,
  (c, s) => {
    const n = c.inputs.period;
    const lag = Math.floor((n - 1) / 2);
    const d = c.buf('d');
    d[c.i] = c.i >= lag ? 2 * s[c.i]! - s[c.i - lag]! : Number.NaN;
    const o = c.buf('o');
    o[c.i] = ema(o, d, c.i, n);
    return o[c.i]!;
  },
);

export const VWMA = defineIndicator({
  id: 'vwma',
  name: 'Volume Weighted Moving Average',
  short: 'VWMA',
  category: 'technical',
  group: 'Moving averages',
  pane: 'overlay',
  description: 'Moving average weighted by bar volume.',
  formula: 'VWMA = Σ(x·vol) / Σ vol',
  inputs: maInputs(20),
  outputs: maOut(HT.special),
  title: (p) => `VWMA ${p.period}${srcLabel(p.source)}`,
  calc(ctx) {
    const s = ctx.src(ctx.inputs.source);
    const v = ctx.src('volume');
    const n = ctx.inputs.period;
    if (ctx.i < n - 1) return;
    let a = 0;
    let w = 0;
    for (let k = ctx.i - n + 1; k <= ctx.i; k++) {
      a += s[k]! * v[k]!;
      w += v[k]!;
    }
    ctx.out.ma.set(ctx.i, w > 0 ? a / w : Number.NaN);
  },
});

export const Envelope = defineIndicator({
  id: 'envelope',
  name: 'Envelope (Bands Envelope)',
  short: 'ENV',
  category: 'technical',
  group: 'Moving averages',
  pane: 'overlay',
  description: 'SMA with bands a fixed percentage above and below.',
  formula: 'Upper/Lower = SMA · (1 ± k/100)',
  inputs: {
    ...maInputs(20),
    pct: input.float('Deviation', 2.5, { min: 0.01, max: 50, step: 0.1, unit: '%' }),
  },
  outputs: {
    basis: output.line('Basis', HT.grey, { unit: 'price' }),
    upper: output.line('Upper', HT.info, { unit: 'price' }),
    lower: output.line('Lower', HT.info, { unit: 'price' }),
  },
  title: (p) => `ENV ${p.period} ${p.pct}%`,
  calc(ctx) {
    const m = sma(ctx.src(ctx.inputs.source), ctx.i, ctx.inputs.period);
    const k = ctx.inputs.pct / 100;
    ctx.out.basis.set(ctx.i, m);
    ctx.out.upper.set(ctx.i, m * (1 + k));
    ctx.out.lower.set(ctx.i, m * (1 - k));
  },
});

export type { InputDefs, OutputDefs };
