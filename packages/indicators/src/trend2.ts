import {
  HT,
  defineIndicator,
  ema,
  highest,
  input,
  lowest,
  output,
  rma,
  sum,
  trueRange,
  highestBarsAgo,
  lowestBarsAgo,
  type CalcContext,
  type InputDefs,
  type Level,
  type Marker,
  type OutputDefs,
} from '@htflow/indicator-sdk';

const trend = { category: 'technical' as const, group: 'Trend' };
const NaN_ = Number.NaN;

type AnyCtx = CalcContext<InputDefs, OutputDefs, unknown>;

/** Wilder directional movement: +DI, −DI, DX at bar i (own scratch buffers, prefix p). */
function dmi(ctx: AnyCtx, n: number, p = ''): { dip: number; dim: number; dx: number } {
  const { i, bars, bar: b } = ctx;
  const pdm = ctx.buf(p + 'pdm');
  const mdm = ctx.buf(p + 'mdm');
  const tr = ctx.buf(p + 'tr');
  if (i > 0) {
    const q = bars[i - 1]!;
    const up = b.h - q.h;
    const dn = q.l - b.l;
    pdm[i] = up > dn && up > 0 ? up : 0;
    mdm[i] = dn > up && dn > 0 ? dn : 0;
    tr[i] = trueRange(b.h, b.l, q.c);
  }
  const sp = ctx.buf(p + 'sp');
  const sm = ctx.buf(p + 'sm');
  const st = ctx.buf(p + 'st');
  sp[i] = rma(sp, pdm, i, n);
  sm[i] = rma(sm, mdm, i, n);
  st[i] = rma(st, tr, i, n);
  const dip = st[i]! > 0 ? (100 * sp[i]!) / st[i]! : NaN_;
  const dim = st[i]! > 0 ? (100 * sm[i]!) / st[i]! : NaN_;
  const dx =
    dip + dim > 0 ? (100 * Math.abs(dip - dim)) / (dip + dim) : Number.isNaN(dip) ? NaN_ : 0;
  return { dip, dim, dx };
}

export const DX = defineIndicator({
  id: 'dx',
  name: 'Directional Movement Index (DX)',
  short: 'DX',
  ...trend,
  pane: 'new',
  description: 'Unsmoothed directional movement: the spread of +DI and −DI.',
  formula: 'DX = 100·|DI+ − DI−| / (DI+ + DI−)',
  range: [0, 100],
  inputs: { period: input.int('DI period', 14, { min: 1, max: 500 }) },
  outputs: { dx: output.line('DX', HT.white) },
  guides: () => [20, 40],
  title: (p) => `DX ${p.period}`,
  calc(ctx) {
    ctx.out.dx.set(ctx.i, dmi(ctx as unknown as AnyCtx, ctx.inputs.period).dx);
  },
});

export const ADXR = defineIndicator({
  id: 'adxr',
  name: 'Average Directional Movement Rating (ADXR)',
  short: 'ADXR',
  ...trend,
  pane: 'new',
  description: 'Average of the current ADX and the ADX n bars ago (a smoother, slower ADX).',
  formula: 'ADXR = (ADX + ADX[n]) / 2',
  range: [0, 100],
  inputs: {
    period: input.int('DI period', 14, { min: 1, max: 500 }),
    lookback: input.int('Lookback', 14, { min: 1, max: 500 }),
  },
  outputs: {
    adxr: output.line('ADXR', HT.white),
    adx: output.line('ADX', HT.grey, { width: 1, style: 'dashed' }),
  },
  guides: () => [20, 40],
  title: (p) => `ADXR ${p.period} ${p.lookback}`,
  calc(ctx) {
    const { dx } = dmi(ctx as unknown as AnyCtx, ctx.inputs.period);
    const dxb = ctx.buf('dxv');
    dxb[ctx.i] = dx;
    const a = ctx.out.adx.v;
    a[ctx.i] = rma(a, dxb, ctx.i, ctx.inputs.period);
    const k = ctx.i - ctx.inputs.lookback;
    if (k >= 0) ctx.out.adxr.set(ctx.i, (a[ctx.i]! + a[k]!) / 2);
  },
});

export const DMI = defineIndicator({
  id: 'dmi',
  name: 'Directional Movement System (DMI)',
  short: 'DMI',
  ...trend,
  pane: 'new',
  description: "Wilder's full system: +DI, −DI, ADX and ADXR in one pane.",
  formula: 'DI± = 100·RMA(DM±)/RMA(TR); ADX = RMA(DX); ADXR = (ADX + ADX[n]) / 2',
  range: [0, 100],
  inputs: {
    period: input.int('DI period', 14, { min: 1, max: 500 }),
    smooth: input.int('ADX smoothing', 14, { min: 1, max: 500 }),
  },
  outputs: {
    plus: output.line('DI+', HT.up),
    minus: output.line('DI−', HT.down),
    adx: output.line('ADX', HT.white),
    adxr: output.line('ADXR', HT.grey, { style: 'dashed', width: 1 }),
  },
  guides: () => [20, 40],
  title: (p) => `DMI ${p.period} ${p.smooth}`,
  calc(ctx) {
    const { dip, dim, dx } = dmi(ctx as unknown as AnyCtx, ctx.inputs.period);
    ctx.out.plus.set(ctx.i, dip);
    ctx.out.minus.set(ctx.i, dim);
    const dxb = ctx.buf('dxv');
    dxb[ctx.i] = dx;
    const a = ctx.out.adx.v;
    a[ctx.i] = rma(a, dxb, ctx.i, ctx.inputs.smooth);
    const k = ctx.i - ctx.inputs.smooth;
    if (k >= 0) ctx.out.adxr.set(ctx.i, (a[ctx.i]! + a[k]!) / 2);
  },
});

export const AroonOsc = defineIndicator({
  id: 'aroon-osc',
  name: 'Aroon Oscillator',
  short: 'Aroon Osc',
  ...trend,
  pane: 'new',
  description: 'Aroon Up minus Aroon Down.',
  formula: 'Osc = 100·(barsSince(LL) − barsSince(HH))/n',
  range: [-100, 100],
  zeroLine: true,
  inputs: { period: input.int('Period', 14, { min: 1, max: 500 }) },
  outputs: { osc: output.histogram('Aroon Osc', HT.up, { color2: HT.down, opacity: 0.75 }) },
  title: (p) => `Aroon Osc ${p.period}`,
  calc(ctx) {
    const n = ctx.inputs.period;
    if (ctx.i < n) return;
    const up = (100 * (n - highestBarsAgo(ctx.src('high'), ctx.i, n + 1))) / n;
    const dn = (100 * (n - lowestBarsAgo(ctx.src('low'), ctx.i, n + 1))) / n;
    ctx.out.osc.set(ctx.i, up - dn, up - dn >= 0 ? 0 : 1);
  },
});

const alligatorInputs = {
  jaw: input.int('Jaw period', 13, { min: 1, max: 200 }),
  jawShift: input.int('Jaw shift', 8, { min: 0, max: 100 }),
  teeth: input.int('Teeth period', 8, { min: 1, max: 200 }),
  teethShift: input.int('Teeth shift', 5, { min: 0, max: 100 }),
  lips: input.int('Lips period', 5, { min: 1, max: 200 }),
  lipsShift: input.int('Lips shift', 3, { min: 0, max: 100 }),
};

export const Alligator = defineIndicator({
  id: 'alligator',
  name: "Williams' Alligator",
  short: 'Alligator',
  ...trend,
  pane: 'overlay',
  description: 'Three smoothed moving averages of the median price, displaced forward.',
  formula: 'Jaw = SMMA(HL2, 13) → +8; Teeth = SMMA(HL2, 8) → +5; Lips = SMMA(HL2, 5) → +3',
  inputs: alligatorInputs,
  outputs: {
    jaw: output.line('Jaw', HT.info, { unit: 'price', width: 1.5 }),
    teeth: output.line('Teeth', HT.down, { unit: 'price', width: 1.5 }),
    lips: output.line('Lips', HT.up, { unit: 'price', width: 1.5 }),
  },
  title: (p) => `Alligator ${p.jaw}/${p.teeth}/${p.lips}`,
  calc(ctx) {
    const s = ctx.src('hl2');
    const i = ctx.i;
    const { jaw, teeth, lips, jawShift, teethShift, lipsShift } = ctx.inputs;
    const j = ctx.buf('j');
    const t = ctx.buf('t');
    const l = ctx.buf('l');
    j[i] = rma(j, s, i, jaw);
    t[i] = rma(t, s, i, teeth);
    l[i] = rma(l, s, i, lips);
    if (i - jawShift >= 0) ctx.out.jaw.set(i, j[i - jawShift]!);
    if (i - teethShift >= 0) ctx.out.teeth.set(i, t[i - teethShift]!);
    if (i - lipsShift >= 0) ctx.out.lips.set(i, l[i - lipsShift]!);
  },
});

export const Gator = defineIndicator({
  id: 'gator',
  name: 'Gator Oscillator',
  short: 'Gator',
  ...trend,
  pane: 'new',
  description: 'Convergence / divergence of the Alligator lines as two mirrored histograms.',
  formula:
    'Upper = |Jaw − Teeth|; Lower = −|Teeth − Lips| (bars green when larger than the previous bar)',
  zeroLine: true,
  inputs: alligatorInputs,
  outputs: {
    upper: output.histogram('Jaw−Teeth', HT.up, { color2: HT.down, opacity: 0.8 }),
    lower: output.histogram('Teeth−Lips', HT.up, { color2: HT.down, opacity: 0.8 }),
  },
  title: (p) => `Gator ${p.jaw}/${p.teeth}/${p.lips}`,
  calc(ctx) {
    const s = ctx.src('hl2');
    const i = ctx.i;
    const { jaw, teeth, lips, jawShift, teethShift, lipsShift } = ctx.inputs;
    const j = ctx.buf('j');
    const t = ctx.buf('t');
    const l = ctx.buf('l');
    j[i] = rma(j, s, i, jaw);
    t[i] = rma(t, s, i, teeth);
    l[i] = rma(l, s, i, lips);
    if (i - jawShift < 0 || i - teethShift < 0 || i - lipsShift < 0) return;
    const up = ctx.buf('up');
    const lo = ctx.buf('lo');
    up[i] = Math.abs(j[i - jawShift]! - t[i - teethShift]!);
    lo[i] = -Math.abs(t[i - teethShift]! - l[i - lipsShift]!);
    if (Number.isNaN(up[i]! + lo[i]!)) return;
    ctx.out.upper.set(i, up[i]!, i > 0 && !(up[i]! < up[i - 1]!) ? 0 : 1);
    ctx.out.lower.set(i, lo[i]!, i > 0 && !(lo[i]! > lo[i - 1]!) ? 0 : 1);
  },
});

export const Fractals = defineIndicator({
  id: 'fractals',
  name: "Williams' Fractals",
  short: 'Fractals',
  ...trend,
  pane: 'overlay',
  description:
    'Marks bars whose high (low) is the highest (lowest) of n bars on each side. Confirmed n bars later.',
  formula: 'Up fractal: H[i] > H[i±1…n]; Down fractal: L[i] < L[i±1…n]',
  inputs: { n: input.int('Bars each side', 2, { min: 1, max: 20 }) },
  outputs: {
    up: output.markers('Up fractal', HT.down),
    down: output.markers('Down fractal', HT.up),
  },
  title: (p) => `Fractals ${p.n}`,
  calc(ctx) {
    const n = ctx.inputs.n;
    const j = ctx.i - n;
    if (j < n) return;
    const hi = ctx.src('high');
    const lo = ctx.src('low');
    let isUp = true;
    let isDn = true;
    for (let k = 1; k <= n; k++) {
      if (!(hi[j]! > hi[j - k]! && hi[j]! > hi[j + k]!)) isUp = false;
      if (!(lo[j]! < lo[j - k]! && lo[j]! < lo[j + k]!)) isDn = false;
    }
    if (isUp)
      ctx.out.up.add({
        bar: j,
        value: hi[j]!,
        shape: 'triangleDown',
        size: 4,
        tone: 0,
        textPos: 'above',
      } satisfies Marker);
    if (isDn)
      ctx.out.down.add({
        bar: j,
        value: lo[j]!,
        shape: 'triangleUp',
        size: 4,
        tone: 0,
        textPos: 'below',
      } satisfies Marker);
  },
});

export const Vortex = defineIndicator({
  id: 'vortex',
  name: 'Vortex Indicator',
  short: 'Vortex',
  ...trend,
  pane: 'new',
  description:
    'Two lines measuring upward and downward trend movement; a VI+ cross above VI− signals an uptrend.',
  formula: 'VM+ = |H − L₋₁|, VM− = |L − H₋₁|; VI± = Σ_n VM± / Σ_n TR',
  inputs: { period: input.int('Period', 14, { min: 2, max: 500 }) },
  outputs: { plus: output.line('VI+', HT.up), minus: output.line('VI−', HT.down) },
  guides: () => [1],
  title: (p) => `Vortex ${p.period}`,
  calc(ctx) {
    const { i, bar: b } = ctx;
    if (i === 0) return;
    const q = ctx.bars[i - 1]!;
    const vp = ctx.buf('vp');
    const vm = ctx.buf('vm');
    const tr = ctx.buf('tr');
    vp[i] = Math.abs(b.h - q.l);
    vm[i] = Math.abs(b.l - q.h);
    tr[i] = trueRange(b.h, b.l, q.c);
    const n = ctx.inputs.period;
    const t = sum(tr, i, n);
    if (!(t > 0)) return;
    ctx.out.plus.set(i, sum(vp, i, n) / t);
    ctx.out.minus.set(i, sum(vm, i, n) / t);
  },
});

export const MassIndex = defineIndicator({
  id: 'mass-index',
  name: 'Mass Index',
  short: 'Mass',
  ...trend,
  pane: 'new',
  description:
    'Sums the ratio of a single to a double-smoothed high-low range; a "reversal bulge" above 27 then below 26.5 hints at a trend reversal.',
  formula: 'MI = Σ_25 (EMA(H−L, 9) / EMA(EMA(H−L, 9), 9))',
  inputs: {
    ema: input.int('EMA period', 9, { min: 1, max: 200 }),
    sum: input.int('Sum period', 25, { min: 1, max: 500 }),
  },
  outputs: { mi: output.line('Mass', HT.special) },
  guides: () => [26.5, 27],
  title: (p) => `Mass ${p.ema} ${p.sum}`,
  calc(ctx) {
    const i = ctx.i;
    const r = ctx.buf('r');
    r[i] = ctx.bar.h - ctx.bar.l;
    const e1 = ctx.buf('e1');
    const e2 = ctx.buf('e2');
    e1[i] = ema(e1, r, i, ctx.inputs.ema);
    e2[i] = ema(e2, e1, i, ctx.inputs.ema);
    const q = ctx.buf('q');
    q[i] = e2[i]! > 0 ? e1[i]! / e2[i]! : NaN_;
    ctx.out.mi.set(i, sum(q, i, ctx.inputs.sum));
  },
});

export const ChandeKroll = defineIndicator({
  id: 'chande-kroll',
  name: 'Chande Kroll Stop',
  short: 'CK Stop',
  ...trend,
  pane: 'overlay',
  description:
    'Volatility stops for long and short positions built from the ATR and a second smoothing window.',
  formula:
    'H1 = HH(p) − x·ATR(p); L1 = LL(p) + x·ATR(p); StopShort = HH(H1, q); StopLong = LL(L1, q)',
  inputs: {
    p: input.int('ATR / range period', 10, { min: 1, max: 500 }),
    x: input.float('ATR multiplier', 1, { min: 0.1, max: 20, step: 0.1 }),
    q: input.int('Stop period', 9, { min: 1, max: 500 }),
  },
  outputs: {
    short: output.line('Stop short', HT.down, { unit: 'price', width: 1.5 }),
    long: output.line('Stop long', HT.up, { unit: 'price', width: 1.5 }),
  },
  title: (p) => `Chande Kroll ${p.p} ${p.x} ${p.q}`,
  calc(ctx) {
    const { p, x, q } = ctx.inputs;
    const i = ctx.i;
    const tr = ctx.buf('tr');
    tr[i] = trueRange(ctx.bar.h, ctx.bar.l, i > 0 ? ctx.bars[i - 1]!.c : NaN_);
    const atr = ctx.buf('atr');
    atr[i] = rma(atr, tr, i, p);
    const fh = ctx.buf('fh');
    const fl = ctx.buf('fl');
    fh[i] = highest(ctx.src('high'), i, p) - x * atr[i]!;
    fl[i] = lowest(ctx.src('low'), i, p) + x * atr[i]!;
    ctx.out.short.set(i, highest(fh, i, q));
    ctx.out.long.set(i, lowest(fl, i, q));
  },
});

/** Pivot test for bar j = i − right: strictly above `left` bars before, not below `right` bars after. */
function pivotAt(
  hi: ArrayLike<number>,
  lo: ArrayLike<number>,
  j: number,
  left: number,
  right: number,
): { high: boolean; low: boolean } {
  let h = true;
  let l = true;
  for (let k = 1; k <= left; k++) {
    if (!(hi[j]! > hi[j - k]!)) h = false;
    if (!(lo[j]! < lo[j - k]!)) l = false;
  }
  for (let k = 1; k <= right; k++) {
    if (!(hi[j]! >= hi[j + k]!)) h = false;
    if (!(lo[j]! <= lo[j + k]!)) l = false;
  }
  return { high: h, low: l };
}

export { pivotAt };

export const TrendLines = defineIndicator({
  id: 'trend-lines',
  name: 'Trend Lines (auto)',
  short: 'Trend Lines',
  ...trend,
  pane: 'overlay',
  description:
    'Resistance line through the last two swing highs and support line through the last two swing lows, projected forward.',
  formula:
    'line(i) = p₂ + (p₂ − p₁)/(x₂ − x₁)·(i − x₂) through the last two confirmed pivots (strength = bars each side)',
  inputs: {
    left: input.int('Pivot bars left', 5, { min: 1, max: 50 }),
    right: input.int('Pivot bars right', 5, { min: 1, max: 50 }),
  },
  outputs: {
    resistance: output.line('Resistance', HT.down, { unit: 'price', width: 1, style: 'dashed' }),
    support: output.line('Support', HT.up, { unit: 'price', width: 1, style: 'dashed' }),
  },
  title: (p) => `Trend Lines ${p.left}/${p.right}`,
  calc(ctx) {
    const { left, right } = ctx.inputs;
    const i = ctx.i;
    const hi = ctx.src('high');
    const lo = ctx.src('low');
    // carried pivots: [x1, y1, x2, y2] for highs (h*) and lows (l*)
    const names = ['hx1', 'hy1', 'hx2', 'hy2', 'lx1', 'ly1', 'lx2', 'ly2'];
    const b = names.map((n) => ctx.buf(n));
    for (const a of b) a[i] = i > 0 ? a[i - 1]! : NaN_;
    const j = i - right;
    if (j >= left) {
      const pv = pivotAt(hi, lo, j, left, right);
      if (pv.high) {
        b[0]![i] = b[2]![i]!;
        b[1]![i] = b[3]![i]!;
        b[2]![i] = j;
        b[3]![i] = hi[j]!;
      }
      if (pv.low) {
        b[4]![i] = b[6]![i]!;
        b[5]![i] = b[7]![i]!;
        b[6]![i] = j;
        b[7]![i] = lo[j]!;
      }
    }
    const proj = (x1: number, y1: number, x2: number, y2: number) =>
      Number.isNaN(x1 + x2) ? NaN_ : y2 + ((y2 - y1) / (x2 - x1)) * (i - x2);
    ctx.out.resistance.set(i, proj(b[0]![i]!, b[1]![i]!, b[2]![i]!, b[3]![i]!));
    ctx.out.support.set(i, proj(b[4]![i]!, b[5]![i]!, b[6]![i]!, b[7]![i]!));
  },
});

export const MarketStructure = defineIndicator({
  id: 'market-structure',
  name: 'Market Structure (BOS / CHoCH)',
  short: 'Structure',
  ...trend,
  pane: 'overlay',
  autoscale: false,
  description:
    'Swing highs / lows and the closes that break them. BOS = break in the direction of the trend (continuation); CHoCH = first break against the trend (change of character).',
  formula:
    'Pivot = extreme of n bars each side. Close > last swing high → bullish break (BOS if trend was up, CHoCH if it was down); close < last swing low → bearish break.',
  inputs: { n: input.int('Swing bars each side', 5, { min: 1, max: 50 }) },
  outputs: {
    breaks: output.markers('Breaks', HT.up, { color2: HT.down }),
    levels: output.levels('Broken level', HT.grey, { style: 'dashed' }),
  },
  title: (p) => `Structure ${p.n}`,
  calc(ctx) {
    const n = ctx.inputs.n;
    const i = ctx.i;
    const hi = ctx.src('high');
    const lo = ctx.src('low');
    const sh = ctx.buf('sh'); // last swing high price
    const shx = ctx.buf('shx');
    const sl = ctx.buf('sl');
    const slx = ctx.buf('slx');
    const trendB = ctx.buf('trend'); // 1 up, -1 down, 0 unknown
    const hOk = ctx.buf('hok'); // 1 = swing high still unbroken
    const lOk = ctx.buf('lok');
    for (const a of [sh, shx, sl, slx, trendB, hOk, lOk]) a[i] = i > 0 ? a[i - 1]! : NaN_;
    if (i === 0) trendB[0] = 0;
    const j = i - n;
    if (j >= n) {
      const pv = pivotAt(hi, lo, j, n, n);
      if (pv.high) {
        sh[i] = hi[j]!;
        shx[i] = j;
        hOk[i] = 1;
      }
      if (pv.low) {
        sl[i] = lo[j]!;
        slx[i] = j;
        lOk[i] = 1;
      }
    }
    const c = ctx.bar.c;
    if (hOk[i] === 1 && c > sh[i]!) {
      const choch = trendB[i] === -1;
      ctx.out.breaks.add({
        bar: i,
        value: sh[i]!,
        shape: 'text',
        size: 0,
        text: choch ? 'CHoCH' : 'BOS',
        tone: 0,
        textPos: 'above',
      } satisfies Marker);
      ctx.out.levels.add({ bar: shx[i]!, to: i, value: sh[i]!, tone: 0 } satisfies Level);
      trendB[i] = 1;
      hOk[i] = 0;
    } else if (lOk[i] === 1 && c < sl[i]!) {
      const choch = trendB[i] === 1;
      ctx.out.breaks.add({
        bar: i,
        value: sl[i]!,
        shape: 'text',
        size: 0,
        text: choch ? 'CHoCH' : 'BOS',
        tone: 1,
        textPos: 'below',
      } satisfies Marker);
      ctx.out.levels.add({ bar: slx[i]!, to: i, value: sl[i]!, tone: 0 } satisfies Level);
      trendB[i] = -1;
      lOk[i] = 0;
    }
  },
});
