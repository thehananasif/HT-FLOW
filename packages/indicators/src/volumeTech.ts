import { HT, defineIndicator, ema, input, output, sum } from '@htflow/indicator-sdk';

const vol = { category: 'technical' as const, group: 'Volume-based', pane: 'new' as const };

export const OBV = defineIndicator({
  id: 'obv',
  name: 'On Balance Volume',
  short: 'OBV',
  ...vol,
  description: 'Cumulative volume signed by the close-to-close direction.',
  formula: 'OBV = OBV₋₁ + sign(C − C₋₁)·Vol',
  inputs: {},
  outputs: { obv: output.line('OBV', HT.info, { unit: 'volume' }) },
  calc(ctx) {
    const o = ctx.out.obv.v;
    const i = ctx.i;
    if (i === 0) {
      o[0] = 0;
      return;
    }
    const d = ctx.bar.c - ctx.bars[i - 1]!.c;
    o[i] = o[i - 1]! + (d > 0 ? ctx.bar.vol : d < 0 ? -ctx.bar.vol : 0);
  },
});

export const MFI = defineIndicator({
  id: 'mfi',
  name: 'Money Flow Index',
  short: 'MFI',
  ...vol,
  description: 'Volume-weighted RSI of the typical price.',
  formula: 'MF = TP·Vol; MFI = 100 − 100/(1 + Σ+MF/Σ−MF)',
  range: [0, 100],
  inputs: { period: input.int('Period', 14, { min: 1, max: 500 }) },
  outputs: { mfi: output.line('MFI', HT.special) },
  guides: () => [20, 80],
  title: (p) => `MFI ${p.period}`,
  calc(ctx) {
    const tp = ctx.src('hlc3');
    const pos = ctx.buf('pos');
    const neg = ctx.buf('neg');
    const i = ctx.i;
    if (i > 0) {
      const mf = tp[i]! * ctx.bar.vol;
      pos[i] = tp[i]! > tp[i - 1]! ? mf : 0;
      neg[i] = tp[i]! < tp[i - 1]! ? mf : 0;
    }
    const p = sum(pos, i, ctx.inputs.period);
    const n = sum(neg, i, ctx.inputs.period);
    ctx.out.mfi.set(i, Number.isNaN(p) ? p : n === 0 ? 100 : 100 - 100 / (1 + p / n));
  },
});

const mfm = (b: { h: number; l: number; c: number }) => (b.h > b.l ? (2 * b.c - b.l - b.h) / (b.h - b.l) : 0);

export const CMF = defineIndicator({
  id: 'cmf',
  name: 'Chaikin Money Flow',
  short: 'CMF',
  ...vol,
  description: 'Sum of money-flow volume over the sum of volume.',
  formula: 'MFM = ((C−L) − (H−C))/(H−L); CMF = Σ(MFM·Vol)/ΣVol',
  range: [-1, 1],
  zeroLine: true,
  inputs: { period: input.int('Period', 20, { min: 1, max: 500 }) },
  outputs: { cmf: output.line('CMF', HT.info) },
  title: (p) => `CMF ${p.period}`,
  calc(ctx) {
    const mfv = ctx.buf('mfv');
    mfv[ctx.i] = mfm(ctx.bar) * ctx.bar.vol;
    const v = sum(ctx.src('volume'), ctx.i, ctx.inputs.period);
    ctx.out.cmf.set(ctx.i, v > 0 ? sum(mfv, ctx.i, ctx.inputs.period) / v : Number.NaN);
  },
});

export const ADLine = defineIndicator({
  id: 'ad-line',
  name: 'Accumulation / Distribution Line',
  short: 'A/D',
  ...vol,
  description: 'Running total of money-flow volume.',
  formula: 'AD = AD₋₁ + MFM·Vol',
  inputs: {},
  outputs: { ad: output.line('A/D', HT.info, { unit: 'volume' }) },
  calc(ctx) {
    const o = ctx.out.ad.v;
    o[ctx.i] = (ctx.i > 0 ? o[ctx.i - 1]! : 0) + mfm(ctx.bar) * ctx.bar.vol;
  },
});

export const PVT = defineIndicator({
  id: 'pvt',
  name: 'Price Volume Trend',
  short: 'PVT',
  ...vol,
  description: 'Cumulative volume weighted by the percentage price change.',
  formula: 'PVT = PVT₋₁ + Vol·(C − C₋₁)/C₋₁',
  inputs: {},
  outputs: { pvt: output.line('PVT', HT.info, { unit: 'volume' }) },
  calc(ctx) {
    const o = ctx.out.pvt.v;
    const i = ctx.i;
    if (i === 0) {
      o[0] = 0;
      return;
    }
    const pc = ctx.bars[i - 1]!.c;
    o[i] = o[i - 1]! + (pc ? (ctx.bar.vol * (ctx.bar.c - pc)) / pc : 0);
  },
});

export const ForceIndex = defineIndicator({
  id: 'force-index',
  name: 'Force Index',
  short: 'FI',
  ...vol,
  description: "Elder's force index: price change × volume, EMA-smoothed.",
  formula: 'FI = EMA((C − C₋₁)·Vol, n)',
  zeroLine: true,
  inputs: { period: input.int('Period', 13, { min: 1, max: 500 }) },
  outputs: { fi: output.line('Force', HT.info, { unit: 'volume' }) },
  title: (p) => `FI ${p.period}`,
  calc(ctx) {
    const raw = ctx.buf('raw');
    if (ctx.i > 0) raw[ctx.i] = (ctx.bar.c - ctx.bars[ctx.i - 1]!.c) * ctx.bar.vol;
    const o = ctx.out.fi.v;
    o[ctx.i] = ema(o, raw, ctx.i, ctx.inputs.period);
  },
});
