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
  sum,
  trueRange,
} from '@htflow/indicator-sdk';

const vol = { category: 'technical' as const, group: 'Volume-based', pane: 'new' as const };
const vola = { category: 'technical' as const, group: 'Volatility' };
const NaN_ = Number.NaN;

const mfm = (b: { h: number; l: number; c: number }) =>
  b.h > b.l ? (2 * b.c - b.l - b.h) / (b.h - b.l) : 0;

export const ChaikinOsc = defineIndicator({
  id: 'chaikin-osc',
  name: 'Chaikin Oscillator',
  short: 'Chaikin Osc',
  ...vol,
  description: 'MACD of the Accumulation / Distribution line.',
  formula: 'ADL = ADL₋₁ + MFM·Vol; CO = EMA(ADL, fast) − EMA(ADL, slow)',
  zeroLine: true,
  inputs: {
    fast: input.int('Fast', 3, { min: 1, max: 200 }),
    slow: input.int('Slow', 10, { min: 2, max: 500 }),
  },
  outputs: {
    co: output.histogram('Chaikin Osc', HT.up, { color2: HT.down, opacity: 0.75, unit: 'volume' }),
  },
  title: (p) => `Chaikin Osc ${p.fast} ${p.slow}`,
  calc(ctx) {
    const i = ctx.i;
    const adl = ctx.buf('adl');
    adl[i] = (i > 0 ? adl[i - 1]! : 0) + mfm(ctx.bar) * ctx.bar.vol;
    const f = ctx.buf('f');
    const s = ctx.buf('s');
    f[i] = ema(f, adl, i, ctx.inputs.fast);
    s[i] = ema(s, adl, i, ctx.inputs.slow);
    const v = f[i]! - s[i]!;
    ctx.out.co.set(i, v, v >= 0 ? 0 : 1);
  },
});

export const EaseOfMovement = defineIndicator({
  id: 'eom',
  name: 'Ease of Movement',
  short: 'EOM',
  ...vol,
  description:
    "Arms' EMV: price movement per unit of volume; high when price moves easily on low volume.",
  formula: 'DM = (H+L)/2 − (H₋+L₋)/2; Box = (Vol/divisor)/(H − L); EOM = SMA(DM/Box, n)',
  zeroLine: true,
  inputs: {
    period: input.int('Period', 14, { min: 1, max: 500 }),
    divisor: input.float('Volume divisor', 10000, { min: 1, max: 1e12, step: 1000 }),
  },
  outputs: { eom: output.line('EOM', HT.info) },
  title: (p) => `EOM ${p.period}`,
  calc(ctx) {
    const i = ctx.i;
    if (i === 0) return;
    const p = ctx.bars[i - 1]!;
    const b = ctx.bar;
    const dm = (b.h + b.l) / 2 - (p.h + p.l) / 2;
    const box = b.h > b.l ? b.vol / ctx.inputs.divisor / (b.h - b.l) : 0;
    const e = ctx.buf('e');
    e[i] = box > 0 ? dm / box : 0;
    ctx.out.eom.set(i, sma(e, i, ctx.inputs.period));
  },
});

export const Klinger = defineIndicator({
  id: 'klinger',
  name: 'Klinger Volume Oscillator',
  short: 'KVO',
  ...vol,
  description: 'Volume force: long-term money flow trend versus short-term fluctuations.',
  formula:
    'T = ±1 by HLC vs previous; cm = cm₋ + dm (same trend) else dm₋ + dm; VF = Vol·|2·dm/cm − 1|·T·100; KVO = EMA(VF, f) − EMA(VF, s)',
  zeroLine: true,
  inputs: {
    fast: input.int('Fast', 34, { min: 1, max: 500 }),
    slow: input.int('Slow', 55, { min: 2, max: 500 }),
    signal: input.int('Signal', 13, { min: 1, max: 200 }),
  },
  outputs: {
    kvo: output.line('KVO', HT.info, { unit: 'volume' }),
    signal: output.line('Signal', HT.warning, { unit: 'volume', width: 1 }),
  },
  title: (p) => `Klinger ${p.fast} ${p.slow} ${p.signal}`,
  calc(ctx) {
    const i = ctx.i;
    if (i === 0) return;
    const b = ctx.bar;
    const p = ctx.bars[i - 1]!;
    const trend = ctx.buf('t');
    const dmb = ctx.buf('dm');
    const cm = ctx.buf('cm');
    const hlc = b.h + b.l + b.c;
    const phlc = p.h + p.l + p.c;
    trend[i] = hlc > phlc ? 1 : -1;
    dmb[i] = b.h - b.l;
    cm[i] =
      i > 1 && trend[i] === trend[i - 1]
        ? cm[i - 1]! + dmb[i]!
        : (i > 1 ? dmb[i - 1]! : p.h - p.l) + dmb[i]!;
    const vf = ctx.buf('vf');
    vf[i] = cm[i]! > 0 ? b.vol * Math.abs((2 * dmb[i]!) / cm[i]! - 1) * trend[i]! * 100 : 0;
    const f = ctx.buf('f');
    const s = ctx.buf('s');
    f[i] = ema(f, vf, i, ctx.inputs.fast);
    s[i] = ema(s, vf, i, ctx.inputs.slow);
    const k = ctx.out.kvo.v;
    k[i] = f[i]! - s[i]!;
    ctx.out.signal.set(i, ema(ctx.out.signal.v, k, i, ctx.inputs.signal));
  },
});

function volIndex(id: string, name: string, short: string, positive: boolean) {
  return defineIndicator({
    id,
    name,
    short,
    ...vol,
    description: `${name}: cumulates price change only on bars where volume ${positive ? 'rises' : 'falls'}.`,
    formula: `${short} = ${short}₋·(1 + (C − C₋)/C₋) when Vol ${positive ? '>' : '<'} Vol₋, else ${short}₋ (start 1000)`,
    inputs: {
      signal: input.int('Signal EMA', 255, { min: 0, max: 500, help: '0 = no signal line.' }),
    },
    outputs: {
      idx: output.line(short, HT.info),
      signal: output.line('Signal', HT.warning, { width: 1 }),
    },
    title: (p) => `${short}${p.signal ? ' ' + p.signal : ''}`,
    calc(ctx) {
      const i = ctx.i;
      const o = ctx.out.idx.v;
      if (i === 0) {
        o[0] = 1000;
        return;
      }
      const p = ctx.bars[i - 1]!;
      const hit = positive ? ctx.bar.vol > p.vol : ctx.bar.vol < p.vol;
      o[i] = hit && p.c !== 0 ? o[i - 1]! * (1 + (ctx.bar.c - p.c) / p.c) : o[i - 1]!;
      if (ctx.inputs.signal > 0)
        ctx.out.signal.set(i, ema(ctx.out.signal.v, o, i, ctx.inputs.signal));
    },
  });
}

export const NVI = volIndex('nvi', 'Negative Volume Index', 'NVI', false);
export const PVI = volIndex('pvi', 'Positive Volume Index', 'PVI', true);

export const VolumeOsc = defineIndicator({
  id: 'volume-osc',
  name: 'Volume Oscillator',
  short: 'Vol Osc',
  ...vol,
  description: 'Percentage difference of a fast and a slow EMA of volume.',
  formula: 'VO = 100·(EMA(Vol, fast) − EMA(Vol, slow)) / EMA(Vol, slow)',
  zeroLine: true,
  inputs: {
    fast: input.int('Fast', 5, { min: 1, max: 200 }),
    slow: input.int('Slow', 10, { min: 2, max: 500 }),
  },
  outputs: {
    vo: output.histogram('Vol Osc', HT.up, { color2: HT.down, opacity: 0.75, unit: 'percent' }),
  },
  title: (p) => `Vol Osc ${p.fast} ${p.slow}`,
  calc(ctx) {
    const v = ctx.src('volume');
    const f = ctx.buf('f');
    const s = ctx.buf('s');
    f[ctx.i] = ema(f, v, ctx.i, ctx.inputs.fast);
    s[ctx.i] = ema(s, v, ctx.i, ctx.inputs.slow);
    const r = s[ctx.i]! > 0 ? (100 * (f[ctx.i]! - s[ctx.i]!)) / s[ctx.i]! : NaN_;
    ctx.out.vo.set(ctx.i, r, r >= 0 ? 0 : 1);
  },
});

export const RelativeVolume = defineIndicator({
  id: 'relative-volume',
  name: 'Relative Volume',
  short: 'RVOL',
  ...vol,
  description: 'Bar volume as a multiple of the average volume of the previous n bars.',
  formula: 'RVOL = Vol / SMA(Vol, n)₋₁',
  inputs: {
    period: input.int('Average bars', 20, { min: 1, max: 1000 }),
    threshold: input.float('Highlight above', 2, { min: 0.1, max: 100, step: 0.1, unit: '×' }),
  },
  outputs: {
    rvol: output.histogram('RVOL', HT.grey, { color2: HT.warning, opacity: 0.8, unit: 'value' }),
  },
  guides: (p) => [1, p.threshold],
  title: (p) => `RVOL ${p.period}`,
  calc(ctx) {
    const avg = sma(ctx.src('volume'), ctx.i - 1, ctx.inputs.period);
    if (!(avg > 0)) return;
    const r = ctx.bar.vol / avg;
    ctx.out.rvol.set(ctx.i, r, r >= ctx.inputs.threshold ? 1 : 0);
  },
});

// ------------------------------------------------------------------ volatility

export const ATRN = defineIndicator({
  id: 'atrn',
  name: 'Normalized ATR',
  short: 'ATRN',
  ...vola,
  pane: 'new',
  description: 'ATR as a percentage of the close, comparable across price levels.',
  formula: 'ATRN = 100·ATR(n) / C',
  inputs: { period: input.int('Period', 14, { min: 1, max: 500 }) },
  outputs: { atrn: output.line('ATRN', HT.warning, { unit: 'percent' }) },
  title: (p) => `ATRN ${p.period}`,
  calc(ctx) {
    const i = ctx.i;
    const tr = ctx.buf('tr');
    tr[i] = trueRange(ctx.bar.h, ctx.bar.l, i > 0 ? ctx.bars[i - 1]!.c : NaN_);
    const a = ctx.buf('a');
    a[i] = rma(a, tr, i, ctx.inputs.period);
    ctx.out.atrn.set(i, ctx.bar.c !== 0 ? (100 * a[i]!) / ctx.bar.c : NaN_);
  },
});

export const HistVol = defineIndicator({
  id: 'hist-vol',
  name: 'Historical Volatility',
  short: 'HV',
  ...vola,
  pane: 'new',
  description: 'Annualised standard deviation of log returns.',
  formula: 'HV = 100·√(periods) · s(ln(C/C₋), n), s = sample standard deviation',
  inputs: {
    period: input.int('Period', 20, { min: 2, max: 1000 }),
    annual: input.int('Bars per year', 365, {
      min: 1,
      max: 1_000_000,
      help: '365 daily bars; 252 for equities; 525600 for 1-minute bars.',
    }),
  },
  outputs: { hv: output.line('HV', HT.special, { unit: 'percent' }) },
  title: (p) => `HV ${p.period}`,
  calc(ctx) {
    const i = ctx.i;
    const n = ctx.inputs.period;
    const r = ctx.buf('r');
    if (i > 0 && ctx.bars[i - 1]!.c > 0 && ctx.bar.c > 0)
      r[i] = Math.log(ctx.bar.c / ctx.bars[i - 1]!.c);
    const m = sma(r, i, n);
    if (Number.isNaN(m)) return;
    let s = 0;
    for (let k = i - n + 1; k <= i; k++) s += (r[k]! - m) ** 2;
    ctx.out.hv.set(i, 100 * Math.sqrt(ctx.inputs.annual) * Math.sqrt(s / (n - 1)));
  },
});

export const Choppiness = defineIndicator({
  id: 'choppiness',
  name: 'Choppiness Index',
  short: 'CHOP',
  ...vola,
  pane: 'new',
  description: 'Values near 100 mean a choppy, sideways market; near 0 a strong trend.',
  formula: 'CHOP = 100·log₁₀(Σ TR(n) / (HH(n) − LL(n))) / log₁₀(n)',
  range: [0, 100],
  inputs: { period: input.int('Period', 14, { min: 2, max: 500 }) },
  outputs: { chop: output.line('CHOP', HT.info) },
  guides: () => [38.2, 61.8],
  title: (p) => `CHOP ${p.period}`,
  calc(ctx) {
    const n = ctx.inputs.period;
    const i = ctx.i;
    const tr = ctx.buf('tr');
    tr[i] = trueRange(ctx.bar.h, ctx.bar.l, i > 0 ? ctx.bars[i - 1]!.c : NaN_);
    const range = highest(ctx.src('high'), i, n) - lowest(ctx.src('low'), i, n);
    const t = sum(tr, i, n);
    if (!(range > 0) || Number.isNaN(t)) return;
    ctx.out.chop.set(i, (100 * Math.log10(t / range)) / Math.log10(n));
  },
});

export const Ulcer = defineIndicator({
  id: 'ulcer',
  name: 'Ulcer Index',
  short: 'UI',
  ...vola,
  pane: 'new',
  description:
    'Downside volatility: the root mean square of percentage drawdowns from the recent high.',
  formula: 'DD = 100·(C − max(C, n))/max(C, n); UI = √(Σ DD² / n)',
  inputs: {
    period: input.int('Period', 14, { min: 2, max: 500 }),
    source: input.source('Source', 'close'),
  },
  outputs: { ui: output.line('UI', HT.down, { unit: 'percent' }) },
  title: (p) => `Ulcer ${p.period}`,
  calc(ctx) {
    const n = ctx.inputs.period;
    const i = ctx.i;
    const s = ctx.src(ctx.inputs.source);
    const dd = ctx.buf('dd');
    const hh = highest(s, i, n);
    dd[i] = hh !== 0 ? (100 * (s[i]! - hh)) / hh : NaN_;
    if (i < 2 * n - 2) return;
    let q = 0;
    for (let k = i - n + 1; k <= i; k++) q += dd[k]! * dd[k]!;
    ctx.out.ui.set(i, Math.sqrt(q / n));
  },
});

export const ChaikinVol = defineIndicator({
  id: 'chaikin-vol',
  name: 'Chaikin Volatility',
  short: 'CV',
  ...vola,
  pane: 'new',
  description: 'Rate of change of the smoothed high-low range.',
  formula: 'CV = 100·(EMA(H − L, n) − EMA(H − L, n)[roc]) / EMA(H − L, n)[roc]',
  zeroLine: true,
  inputs: {
    period: input.int('EMA period', 10, { min: 1, max: 500 }),
    roc: input.int('ROC period', 10, { min: 1, max: 500 }),
  },
  outputs: { cv: output.line('CV', HT.info, { unit: 'percent' }) },
  title: (p) => `Chaikin Vol ${p.period} ${p.roc}`,
  calc(ctx) {
    const i = ctx.i;
    const r = ctx.buf('r');
    r[i] = ctx.bar.h - ctx.bar.l;
    const e = ctx.buf('e');
    e[i] = ema(e, r, i, ctx.inputs.period);
    const k = i - ctx.inputs.roc;
    if (k < 0 || !(e[k]! > 0)) return;
    ctx.out.cv.set(i, (100 * (e[i]! - e[k]!)) / e[k]!);
  },
});

export const RelVolatility = defineIndicator({
  id: 'rvi-vol',
  name: 'Relative Volatility Index',
  short: 'RVI(vol)',
  ...vola,
  pane: 'new',
  description:
    "Dorsey's RVI: an RSI built from the standard deviation of price instead of its change.",
  formula:
    'σ = stdev(C, n); U = σ if C > C₋ else 0; D = σ if C < C₋ else 0; RVI = 100·RMA(U)/(RMA(U) + RMA(D))',
  range: [0, 100],
  inputs: {
    period: input.int('Std-dev period', 10, { min: 2, max: 500 }),
    smooth: input.int('Smoothing', 14, { min: 1, max: 500 }),
    source: input.source('Source', 'close'),
  },
  outputs: { rvi: output.line('RVI', HT.special) },
  guides: () => [30, 50, 70],
  title: (p) => `Rel. Volatility ${p.period} ${p.smooth}`,
  calc(ctx) {
    const i = ctx.i;
    const s = ctx.src(ctx.inputs.source);
    const n = ctx.inputs.period;
    const m = sma(s, i, n);
    if (Number.isNaN(m) || i === 0) return;
    let q = 0;
    for (let k = i - n + 1; k <= i; k++) q += (s[k]! - m) ** 2;
    const sd = Math.sqrt(q / n);
    const u = ctx.buf('u');
    const d = ctx.buf('d');
    u[i] = s[i]! > s[i - 1]! ? sd : 0;
    d[i] = s[i]! < s[i - 1]! ? sd : 0;
    const ua = ctx.buf('ua');
    const da = ctx.buf('da');
    ua[i] = rma(ua, u, i, ctx.inputs.smooth);
    da[i] = rma(da, d, i, ctx.inputs.smooth);
    ctx.out.rvi.set(i, ua[i]! + da[i]! > 0 ? (100 * ua[i]!) / (ua[i]! + da[i]!) : 50);
  },
});
