import {
  HT,
  defineIndicator,
  highest,
  highestBarsAgo,
  input,
  lowest,
  lowestBarsAgo,
  output,
  rma,
  trueRange,
} from '@htflow/indicator-sdk';

const trend = { category: 'technical' as const, group: 'Trend' };
const NaN_ = Number.NaN;

export const ADX = defineIndicator({
  id: 'adx',
  name: 'ADX / DI+ / DI−',
  short: 'ADX',
  ...trend,
  pane: 'new',
  description: "Wilder's Directional Movement System.",
  formula: 'DI± = 100·RMA(DM±)/RMA(TR); DX = 100·|DI+ − DI−|/(DI+ + DI−); ADX = RMA(DX)',
  range: [0, 100],
  inputs: {
    period: input.int('DI period', 14, { min: 1, max: 500 }),
    smooth: input.int('ADX smoothing', 14, { min: 1, max: 500 }),
  },
  outputs: {
    adx: output.line('ADX', HT.white),
    plus: output.line('DI+', HT.up),
    minus: output.line('DI−', HT.down),
  },
  guides: () => [20, 40],
  title: (p) => `ADX ${p.period} ${p.smooth}`,
  calc(ctx) {
    const { i, bars } = ctx;
    const b = ctx.bar;
    const pdm = ctx.buf('pdm');
    const mdm = ctx.buf('mdm');
    const tr = ctx.buf('tr');
    if (i > 0) {
      const p = bars[i - 1]!;
      const up = b.h - p.h;
      const dn = p.l - b.l;
      pdm[i] = up > dn && up > 0 ? up : 0;
      mdm[i] = dn > up && dn > 0 ? dn : 0;
      tr[i] = trueRange(b.h, b.l, p.c);
    }
    const n = ctx.inputs.period;
    const sp = ctx.buf('sp');
    const sm = ctx.buf('sm');
    const st = ctx.buf('st');
    sp[i] = rma(sp, pdm, i, n);
    sm[i] = rma(sm, mdm, i, n);
    st[i] = rma(st, tr, i, n);
    const dip = st[i]! > 0 ? (100 * sp[i]!) / st[i]! : NaN_;
    const dim = st[i]! > 0 ? (100 * sm[i]!) / st[i]! : NaN_;
    ctx.out.plus.set(i, dip);
    ctx.out.minus.set(i, dim);
    const dx = ctx.buf('dx');
    dx[i] =
      dip + dim > 0 ? (100 * Math.abs(dip - dim)) / (dip + dim) : Number.isNaN(dip) ? NaN_ : 0;
    const a = ctx.out.adx.v;
    a[i] = rma(a, dx, i, ctx.inputs.smooth);
  },
});

export const Aroon = defineIndicator({
  id: 'aroon',
  name: 'Aroon',
  short: 'Aroon',
  ...trend,
  pane: 'new',
  description: 'Bars since the n-bar high / low, as a percentage.',
  formula: 'Up = 100·(n − barsSince(HH))/n; Down = 100·(n − barsSince(LL))/n',
  range: [0, 100],
  inputs: { period: input.int('Period', 14, { min: 1, max: 500 }) },
  outputs: { up: output.line('Up', HT.up), down: output.line('Down', HT.down) },
  title: (p) => `Aroon ${p.period}`,
  calc(ctx) {
    const n = ctx.inputs.period;
    if (ctx.i < n) return;
    ctx.out.up.set(ctx.i, (100 * (n - highestBarsAgo(ctx.src('high'), ctx.i, n + 1))) / n);
    ctx.out.down.set(ctx.i, (100 * (n - lowestBarsAgo(ctx.src('low'), ctx.i, n + 1))) / n);
  },
});

export const ParabolicSAR = defineIndicator({
  id: 'psar',
  name: 'Parabolic SAR',
  short: 'SAR',
  ...trend,
  pane: 'overlay',
  description: "Wilder's stop-and-reverse points.",
  formula:
    'SAR = SAR₋₁ + AF·(EP − SAR₋₁); AF += step on new extreme (max AF), reverse on penetration',
  inputs: {
    start: input.float('AF start', 0.02, { min: 0.001, max: 1, step: 0.01 }),
    step: input.float('AF step', 0.02, { min: 0.001, max: 1, step: 0.01 }),
    max: input.float('AF max', 0.2, { min: 0.01, max: 1, step: 0.01 }),
  },
  outputs: { sar: output.dots('SAR', HT.up, { color2: HT.down, unit: 'price', width: 1.5 }) },
  title: (p) => `SAR ${p.start} ${p.max}`,
  calc(ctx) {
    const { i, bars } = ctx;
    const sar = ctx.buf('sar');
    const ep = ctx.buf('ep');
    const af = ctx.buf('af');
    const dir = ctx.buf('dir');
    const b = ctx.bar;
    if (i === 0) return;
    const p = bars[i - 1]!;
    if (i === 1) {
      const up = b.c >= p.c;
      dir[i] = up ? 1 : -1;
      sar[i] = up ? Math.min(p.l, b.l) : Math.max(p.h, b.h);
      ep[i] = up ? b.h : b.l;
      af[i] = ctx.inputs.start;
    } else {
      let d = dir[i - 1]!;
      let s = sar[i - 1]! + af[i - 1]! * (ep[i - 1]! - sar[i - 1]!);
      let e = ep[i - 1]!;
      let a = af[i - 1]!;
      const pp = bars[i - 2]!;
      if (d > 0) {
        s = Math.min(s, p.l, pp.l);
        if (b.l < s) {
          d = -1;
          s = e;
          e = b.l;
          a = ctx.inputs.start;
        } else if (b.h > e) {
          e = b.h;
          a = Math.min(ctx.inputs.max, a + ctx.inputs.step);
        }
      } else {
        s = Math.max(s, p.h, pp.h);
        if (b.h > s) {
          d = 1;
          s = e;
          e = b.h;
          a = ctx.inputs.start;
        } else if (b.l < e) {
          e = b.l;
          a = Math.min(ctx.inputs.max, a + ctx.inputs.step);
        }
      }
      dir[i] = d;
      sar[i] = s;
      ep[i] = e;
      af[i] = a;
    }
    ctx.out.sar.set(i, sar[i]!, dir[i]! > 0 ? 0 : 1);
  },
});

export const SuperTrend = defineIndicator({
  id: 'supertrend',
  name: 'SuperTrend',
  short: 'ST',
  ...trend,
  pane: 'overlay',
  description: 'ATR trailing stop that flips with the trend.',
  formula: 'Bands = HL2 ± k·ATR; final bands trail; trend flips when close crosses the active band',
  inputs: {
    period: input.int('ATR period', 10, { min: 1, max: 500 }),
    mult: input.float('Multiplier', 3, { min: 0.1, max: 20, step: 0.1 }),
  },
  outputs: {
    up: output.line('Up trend', HT.up, { unit: 'price', width: 2 }),
    down: output.line('Down trend', HT.down, { unit: 'price', width: 2 }),
  },
  title: (p) => `ST ${p.period} ${p.mult}`,
  calc(ctx) {
    const { i } = ctx;
    const b = ctx.bar;
    const c = ctx.src('close');
    const tr = ctx.buf('tr');
    tr[i] = trueRange(b.h, b.l, i > 0 ? c[i - 1]! : NaN_);
    const atr = ctx.buf('atr');
    atr[i] = rma(atr, tr, i, ctx.inputs.period);
    if (Number.isNaN(atr[i]!)) return;
    const mid = (b.h + b.l) / 2;
    const bu = mid + ctx.inputs.mult * atr[i]!;
    const bl = mid - ctx.inputs.mult * atr[i]!;
    const fu = ctx.buf('fu');
    const fl = ctx.buf('fl');
    const dir = ctx.buf('dir');
    const pu = fu[i - 1] ?? NaN_;
    const pl = fl[i - 1] ?? NaN_;
    const pc = c[i - 1]!;
    fu[i] = Number.isNaN(pu) || bu < pu || pc > pu ? bu : pu;
    fl[i] = Number.isNaN(pl) || bl > pl || pc < pl ? bl : pl;
    const pd = Number.isNaN(dir[i - 1] ?? NaN_) ? 1 : dir[i - 1]!;
    let d = pd;
    if (pd > 0 && b.c < fl[i]!) d = -1;
    else if (pd < 0 && b.c > fu[i]!) d = 1;
    dir[i] = d;
    if (d > 0) ctx.out.up.set(i, fl[i]!);
    else ctx.out.down.set(i, fu[i]!);
  },
});

export const Ichimoku = defineIndicator({
  id: 'ichimoku',
  name: 'Ichimoku Cloud',
  short: 'Ichimoku',
  ...trend,
  pane: 'overlay',
  description: 'Tenkan, Kijun, Senkou spans (cloud, shifted forward) and Chikou (shifted back).',
  formula:
    'Tenkan = (HH9+LL9)/2; Kijun = (HH26+LL26)/2; A = (T+K)/2 → +26; B = (HH52+LL52)/2 → +26; Chikou = C → −26',
  inputs: {
    tenkan: input.int('Tenkan', 9, { min: 1, max: 200 }),
    kijun: input.int('Kijun', 26, { min: 1, max: 200 }),
    senkou: input.int('Senkou B', 52, { min: 1, max: 400 }),
    shift: input.int('Displacement', 26, { min: 0, max: 200 }),
  },
  outputs: {
    cloud: output.band('Cloud', HT.up, { color2: HT.down, legend: false }),
    tenkan: output.line('Tenkan', HT.info, { unit: 'price', width: 1 }),
    kijun: output.line('Kijun', HT.down, { unit: 'price', width: 1 }),
    a: output.line('Senkou A', HT.up, { unit: 'price', width: 1, opacity: 0.6 }),
    b: output.line('Senkou B', HT.down, { unit: 'price', width: 1, opacity: 0.6 }),
    chikou: output.line('Chikou', HT.special, { unit: 'price', width: 1, legend: false }),
  },
  title: (p) => `Ichimoku ${p.tenkan} ${p.kijun} ${p.senkou}`,
  calc(ctx) {
    const { i } = ctx;
    const hi = ctx.src('high');
    const lo = ctx.src('low');
    const mid = (n: number, k: number) => (highest(hi, k, n) + lowest(lo, k, n)) / 2;
    const t = mid(ctx.inputs.tenkan, i);
    const k = mid(ctx.inputs.kijun, i);
    ctx.out.tenkan.set(i, t);
    ctx.out.kijun.set(i, k);
    const j = i - ctx.inputs.shift;
    if (j >= 0) {
      const a = (mid(ctx.inputs.tenkan, j) + mid(ctx.inputs.kijun, j)) / 2;
      const bb = mid(ctx.inputs.senkou, j);
      ctx.out.a.set(i, a);
      ctx.out.b.set(i, bb);
      if (!Number.isNaN(a + bb)) ctx.out.cloud.setPair(i, a, bb, a >= bb ? 0 : 1);
      ctx.out.chikou.set(j, ctx.bar.c);
    }
  },
});

export const ZigZag = defineIndicator({
  id: 'zigzag',
  name: 'ZigZag',
  short: 'ZZ',
  ...trend,
  pane: 'overlay',
  autoscale: false,
  description: 'Connects swing highs and lows that reverse by at least the deviation.',
  formula: 'A new pivot is confirmed when price reverses ≥ deviation % from the running extreme',
  inputs: { deviation: input.float('Deviation', 1, { min: 0.01, max: 50, step: 0.05, unit: '%' }) },
  outputs: { zz: output.line('ZigZag', HT.warning, { unit: 'price', width: 1.5 }) },
  title: (p) => `ZigZag ${p.deviation}%`,
  calc(ctx) {
    const { i } = ctx;
    const b = ctx.bar;
    const dir = ctx.buf('dir');
    const pI = ctx.buf('pI');
    const pP = ctx.buf('pP');
    const eI = ctx.buf('eI');
    const eP = ctx.buf('eP');
    const dev = ctx.inputs.deviation / 100;
    if (i === 0) {
      dir[0] = 1;
      pI[0] = 0;
      pP[0] = b.l;
      eI[0] = 0;
      eP[0] = b.h;
    } else {
      let d = dir[i - 1]!;
      let pi = pI[i - 1]!;
      let pp = pP[i - 1]!;
      let ei = eI[i - 1]!;
      let ep = eP[i - 1]!;
      if (d > 0) {
        if (b.h > ep) {
          ei = i;
          ep = b.h;
        } else if (b.l <= ep * (1 - dev)) {
          pi = ei;
          pp = ep;
          d = -1;
          ei = i;
          ep = b.l;
        }
      } else if (b.l < ep) {
        ei = i;
        ep = b.l;
      } else if (b.h >= ep * (1 + dev)) {
        pi = ei;
        pp = ep;
        d = 1;
        ei = i;
        ep = b.h;
      }
      dir[i] = d;
      pI[i] = pi;
      pP[i] = pp;
      eI[i] = ei;
      eP[i] = ep;
    }
    const v = ctx.out.zz.v;
    const pi = pI[i]!;
    const ei = eI[i]!;
    for (let k = pi; k <= i; k++)
      v[k] =
        k <= ei ? (ei === pi ? pP[i]! : pP[i]! + ((eP[i]! - pP[i]!) * (k - pi)) / (ei - pi)) : NaN_;
  },
});

export const HeikinAshi = defineIndicator({
  id: 'heikin-ashi',
  name: 'Heikin-Ashi overlay',
  short: 'HA',
  category: 'technical',
  group: 'Levels & structure',
  pane: 'overlay',
  description: 'Heikin-Ashi candles drawn over the price bars.',
  formula: 'C = OHLC4; O = (O₋₁ + C₋₁)/2; H = max(H, O, C); L = min(L, O, C)',
  inputs: {},
  outputs: {
    ha: output.bars('Heikin-Ashi', HT.up, { color2: HT.down, opacity: 0.8, unit: 'price' }),
  },
  calc(ctx) {
    const { i } = ctx;
    const b = ctx.bar;
    const c = (b.o + b.h + b.l + b.c) / 4;
    const s = ctx.out.ha;
    const o =
      i > 0 && !Number.isNaN(s.v[i - 1]!) ? (s.v[i - 1]! + s.v4[i - 1]!) / 2 : (b.o + b.c) / 2;
    s.setBar(i, o, Math.max(b.h, o, c), Math.min(b.l, o, c), c);
  },
});
