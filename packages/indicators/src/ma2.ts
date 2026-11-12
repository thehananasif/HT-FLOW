import {
  HT,
  defineIndicator,
  ema,
  highest,
  input,
  lowest,
  output,
  sma,
  type Marker,
} from '@htflow/indicator-sdk';
import { MA_TYPES, maAt, srcLabel, type MaType } from './common';

const maMeta = {
  category: 'technical' as const,
  group: 'Moving averages',
  pane: 'overlay' as const,
};
const NaN_ = Number.NaN;

const periodIn = (n: number, max = 1000) => input.int('Period', n, { min: 1, max });
const sourceIn = () => input.source('Source', 'close');

export const ALMA = defineIndicator({
  id: 'alma',
  name: 'Arnaud Legoux Moving Average',
  short: 'ALMA',
  ...maMeta,
  description: 'Gaussian-weighted moving average with an adjustable offset (lag vs smoothness).',
  formula:
    'm = ⌊offset·(n−1)⌋, s = n/σ; w_k = exp(−(k−m)²/(2s²)); ALMA = Σ w_k·x_k / Σ w_k (k = 0 oldest … n−1)',
  inputs: {
    period: periodIn(9),
    offset: input.float('Offset', 0.85, {
      min: 0,
      max: 1,
      step: 0.05,
      help: '0 = lag, 1 = responsive.',
    }),
    sigma: input.float('Sigma', 6, {
      min: 0.5,
      max: 50,
      step: 0.5,
      help: 'Width of the Gaussian window.',
    }),
    source: sourceIn(),
  },
  outputs: { ma: output.line('ALMA', HT.info, { unit: 'price' }) },
  title: (p) => `ALMA ${p.period} ${p.offset} ${p.sigma}${srcLabel(p.source)}`,
  calc(ctx) {
    const { period: n, offset, sigma } = ctx.inputs;
    const s = ctx.src(ctx.inputs.source);
    const i = ctx.i;
    if (i < n - 1) return;
    const m = Math.floor(offset * (n - 1));
    const sd = n / sigma;
    let a = 0;
    let w = 0;
    for (let k = 0; k < n; k++) {
      const x = s[i - n + 1 + k]!;
      if (Number.isNaN(x)) return;
      const wk = Math.exp(-((k - m) * (k - m)) / (2 * sd * sd));
      a += wk * x;
      w += wk;
    }
    ctx.out.ma.set(i, a / w);
  },
});

export const KAMA = defineIndicator({
  id: 'kama',
  name: 'Kaufman Adaptive Moving Average',
  short: 'KAMA',
  ...maMeta,
  description: 'Moving average whose smoothing follows the efficiency ratio of price.',
  formula:
    'ER = |x − x[n]| / Σ|Δx|; sc = (ER·(2/(f+1) − 2/(s+1)) + 2/(s+1))²; KAMA = KAMA₋₁ + sc·(x − KAMA₋₁)',
  inputs: {
    period: periodIn(10, 500),
    fast: input.int('Fast period', 2, { min: 1, max: 100 }),
    slow: input.int('Slow period', 30, { min: 2, max: 500 }),
    source: sourceIn(),
  },
  outputs: { ma: output.line('KAMA', HT.warning, { unit: 'price' }) },
  title: (p) => `KAMA ${p.period} ${p.fast} ${p.slow}${srcLabel(p.source)}`,
  calc(ctx) {
    const { period: n, fast, slow } = ctx.inputs;
    const s = ctx.src(ctx.inputs.source);
    const i = ctx.i;
    if (i < n) return;
    let vol = 0;
    for (let k = i - n + 1; k <= i; k++) vol += Math.abs(s[k]! - s[k - 1]!);
    const er = vol > 0 ? Math.abs(s[i]! - s[i - n]!) / vol : 0;
    const f = 2 / (fast + 1);
    const sl = 2 / (slow + 1);
    const sc = (er * (f - sl) + sl) ** 2;
    const o = ctx.out.ma.v;
    const prev = i > 0 && !Number.isNaN(o[i - 1]!) ? o[i - 1]! : s[i - 1]!;
    o[i] = prev + sc * (s[i]! - prev);
  },
});

export const FRAMA = defineIndicator({
  id: 'frama',
  name: 'Fractal Adaptive Moving Average',
  short: 'FRAMA',
  ...maMeta,
  description: "Ehlers' FRAMA: the smoothing follows the fractal dimension of the high-low range.",
  formula:
    'D = (ln(N1+N2) − ln N3)/ln 2 with N = range/length of the 2 halves and the whole window; α = exp(−4.6·(D−1)) clamped to [2/(slow+1), 2/(fast+1)]',
  inputs: {
    period: input.int('Period (even)', 16, { min: 4, max: 500, step: 2 }),
    fast: input.int('Fast limit', 1, { min: 1, max: 100 }),
    slow: input.int('Slow limit', 200, { min: 2, max: 1000 }),
    source: sourceIn(),
  },
  outputs: { ma: output.line('FRAMA', HT.special, { unit: 'price' }) },
  title: (p) => `FRAMA ${p.period}${srcLabel(p.source)}`,
  calc(ctx) {
    const n = ctx.inputs.period - (ctx.inputs.period % 2);
    const h = n / 2;
    const s = ctx.src(ctx.inputs.source);
    const hi = ctx.src('high');
    const lo = ctx.src('low');
    const i = ctx.i;
    if (i < n - 1) return;
    const n1 = (highest(hi, i, h) - lowest(lo, i, h)) / h;
    const n2 = (highest(hi, i - h, h) - lowest(lo, i - h, h)) / h;
    const n3 = (highest(hi, i, n) - lowest(lo, i, n)) / n;
    const aMin = 2 / (ctx.inputs.slow + 1);
    const aMax = 2 / (ctx.inputs.fast + 1);
    let alpha = aMin;
    if (n1 + n2 > 0 && n3 > 0) {
      const d = (Math.log(n1 + n2) - Math.log(n3)) / Math.LN2;
      alpha = Math.min(aMax, Math.max(aMin, Math.exp(-4.6 * (d - 1))));
    }
    const o = ctx.out.ma.v;
    const prev = i > 0 ? o[i - 1]! : NaN_;
    o[i] = Number.isNaN(prev) ? s[i]! : prev + alpha * (s[i]! - prev);
  },
});

export const VIDYA = defineIndicator({
  id: 'vidya',
  name: "Chande's Variable Index Dynamic Average",
  short: 'VIDYA',
  ...maMeta,
  description: 'EMA whose smoothing is scaled by the absolute Chande Momentum Oscillator.',
  formula: 'α = 2/(n+1)·|CMO(m)|/100; VIDYA = VIDYA₋₁ + α·(x − VIDYA₋₁)',
  inputs: {
    period: periodIn(14, 500),
    cmo: input.int('CMO period', 9, { min: 2, max: 500 }),
    source: sourceIn(),
  },
  outputs: { ma: output.line('VIDYA', HT.info, { unit: 'price' }) },
  title: (p) => `VIDYA ${p.period} ${p.cmo}${srcLabel(p.source)}`,
  calc(ctx) {
    const m = ctx.inputs.cmo;
    const s = ctx.src(ctx.inputs.source);
    const i = ctx.i;
    if (i < m) return;
    let up = 0;
    let dn = 0;
    for (let k = i - m + 1; k <= i; k++) {
      const d = s[k]! - s[k - 1]!;
      if (d > 0) up += d;
      else dn -= d;
    }
    const cmo = up + dn > 0 ? Math.abs(up - dn) / (up + dn) : 0;
    const alpha = (2 / (ctx.inputs.period + 1)) * cmo;
    const o = ctx.out.ma.v;
    const prev = Number.isNaN(o[i - 1]!) ? s[i - 1]! : o[i - 1]!;
    o[i] = prev + alpha * (s[i]! - prev);
  },
});

export const T3 = defineIndicator({
  id: 't3',
  name: 'Tillson T3',
  short: 'T3',
  ...maMeta,
  description: 'Six cascaded EMAs combined with a volume factor for very low lag.',
  formula: 'e1…e6 = EMA chain; T3 = c1·e6 + c2·e5 + c3·e4 + c4·e3 (c from the volume factor v)',
  inputs: {
    period: periodIn(5, 500),
    v: input.float('Volume factor', 0.7, { min: 0, max: 1, step: 0.05 }),
    source: sourceIn(),
  },
  outputs: { ma: output.line('T3', HT.warning, { unit: 'price' }) },
  title: (p) => `T3 ${p.period} ${p.v}${srcLabel(p.source)}`,
  calc(ctx) {
    const n = ctx.inputs.period;
    const v = ctx.inputs.v;
    const s = ctx.src(ctx.inputs.source);
    const e = [1, 2, 3, 4, 5, 6].map((k) => ctx.buf('e' + k));
    const i = ctx.i;
    e[0]![i] = ema(e[0]!, s, i, n);
    for (let k = 1; k < 6; k++) e[k]![i] = ema(e[k]!, e[k - 1]!, i, n);
    const c1 = -v * v * v;
    const c2 = 3 * v * v + 3 * v * v * v;
    const c3 = -6 * v * v - 3 * v - 3 * v * v * v;
    const c4 = 1 + 3 * v + v * v * v + 3 * v * v;
    ctx.out.ma.set(i, c1 * e[5]![i]! + c2 * e[4]![i]! + c3 * e[3]![i]! + c4 * e[2]![i]!);
  },
});

export const McGinley = defineIndicator({
  id: 'mcginley',
  name: 'McGinley Dynamic',
  short: 'McGinley',
  ...maMeta,
  description:
    'Self-adjusting moving average that speeds up in falling markets and slows in rising ones.',
  formula: 'MD = MD₋₁ + (x − MD₋₁) / (k·n·(x/MD₋₁)⁴)',
  inputs: {
    period: periodIn(14, 500),
    k: input.float('Constant k', 0.6, { min: 0.1, max: 2, step: 0.05 }),
    source: sourceIn(),
  },
  outputs: { ma: output.line('MD', HT.up, { unit: 'price' }) },
  title: (p) => `McGinley ${p.period}${srcLabel(p.source)}`,
  calc(ctx) {
    const s = ctx.src(ctx.inputs.source);
    const o = ctx.out.ma.v;
    const i = ctx.i;
    const prev = i > 0 ? o[i - 1]! : NaN_;
    if (Number.isNaN(prev) || prev === 0) {
      o[i] = s[i]!;
      return;
    }
    const r = s[i]! / prev;
    o[i] = prev + (s[i]! - prev) / (ctx.inputs.k * ctx.inputs.period * r ** 4);
  },
});

export const BlockMA = defineIndicator({
  id: 'block-ma',
  name: 'Block MA / BWMA',
  short: 'BWMA',
  ...maMeta,
  description:
    'BWMA: moving average with Blackman-window weights. Block MA: the mean of the last completed block of n bars, held until the next block completes.',
  formula:
    'BWMA = Σ w_k·x_k / Σ w_k, w_k = 0.42 − 0.5·cos(2πk/(n−1)) + 0.08·cos(4πk/(n−1)); Block = SMA(n) at the last block boundary',
  inputs: {
    mode: input.enum('Mode', 'bwma', [
      ['bwma', 'BWMA (Blackman window)'],
      ['block', 'Block MA (stepped)'],
    ]),
    period: input.int('Period', 20, { min: 3, max: 1000 }),
    source: sourceIn(),
  },
  outputs: { ma: output.line('MA', HT.soft, { unit: 'price' }) },
  title: (p) => `${p.mode === 'bwma' ? 'BWMA' : 'Block MA'} ${p.period}${srcLabel(p.source)}`,
  calc(ctx) {
    const n = ctx.inputs.period;
    const s = ctx.src(ctx.inputs.source);
    const i = ctx.i;
    if (ctx.inputs.mode === 'block') {
      const b = i - (i % n);
      if (b >= n) ctx.out.ma.set(i, sma(s, b - 1, n));
      return;
    }
    if (i < n - 1) return;
    let a = 0;
    let w = 0;
    for (let k = 0; k < n; k++) {
      const x = s[i - n + 1 + k]!;
      if (Number.isNaN(x)) return;
      const wk =
        0.42 -
        0.5 * Math.cos((2 * Math.PI * k) / (n - 1)) +
        0.08 * Math.cos((4 * Math.PI * k) / (n - 1));
      a += wk * x;
      w += wk;
    }
    ctx.out.ma.set(i, a / w);
  },
});

export const Jurik = defineIndicator({
  id: 'jurik',
  name: 'Jurik-style smooth',
  short: 'JMA',
  ...maMeta,
  description:
    'Original three-stage adaptive smoother in the style of the Jurik MA (low lag, low overshoot): an adaptive EMA, a Kalman-like velocity stage and a corrected output stage.',
  formula:
    'β = 0.45(n−1)/(0.45(n−1)+2), α = β^power; e0 = (1−α)x + α·e0₋; e1 = (x−e0)(1−β) + β·e1₋; e2 = (e0 + φ·e1 − J₋)(1−α)² + α²·e2₋; J = J₋ + e2',
  inputs: {
    period: periodIn(14, 500),
    phase: input.float('Phase', 0, {
      min: -100,
      max: 100,
      step: 5,
      help: '−100 = smooth, +100 = fast with overshoot.',
    }),
    power: input.float('Power', 2, { min: 1, max: 5, step: 0.5 }),
    source: sourceIn(),
  },
  outputs: { ma: output.line('JMA', HT.warning, { unit: 'price' }) },
  title: (p) => `Jurik ${p.period} ${p.phase}${srcLabel(p.source)}`,
  calc(ctx) {
    const { period: n, phase, power } = ctx.inputs;
    const s = ctx.src(ctx.inputs.source);
    const i = ctx.i;
    const e0 = ctx.buf('e0');
    const e1 = ctx.buf('e1');
    const e2 = ctx.buf('e2');
    const j = ctx.out.ma.v;
    const x = s[i]!;
    if (Number.isNaN(x)) return;
    if (i === 0 || Number.isNaN(j[i - 1]!)) {
      e0[i] = x;
      e1[i] = 0;
      e2[i] = 0;
      j[i] = x;
      return;
    }
    const beta = (0.45 * (n - 1)) / (0.45 * (n - 1) + 2);
    const alpha = beta ** power;
    const phi = phase < -100 ? 0.5 : phase > 100 ? 2.5 : phase / 100 + 1.5;
    e0[i] = (1 - alpha) * x + alpha * e0[i - 1]!;
    e1[i] = (x - e0[i]!) * (1 - beta) + beta * e1[i - 1]!;
    e2[i] = (e0[i]! + phi * e1[i]! - j[i - 1]!) * (1 - alpha) ** 2 + alpha * alpha * e2[i - 1]!;
    j[i] = e2[i]! + j[i - 1]!;
  },
});

const RIBBON_COLORS = [
  HT.info,
  '#5BB0F0',
  '#6FBDE8',
  '#86C9D9',
  '#9CD3BE',
  '#B6D89F',
  '#D3D888',
  HT.warning,
];

export const MARibbon = defineIndicator({
  id: 'ma-ribbon',
  name: 'MA Ribbon',
  short: 'Ribbon',
  ...maMeta,
  description: 'A family of up to 8 moving averages with evenly increasing periods.',
  formula: 'MA_k = MA(type, start + (k−1)·step), k = 1…count',
  inputs: {
    type: input.enum('Type', 'ema', MA_TYPES),
    start: input.int('First period', 10, { min: 1, max: 500 }),
    step: input.int('Period step', 5, { min: 1, max: 200 }),
    count: input.int('Lines', 8, { min: 2, max: 8 }),
    source: sourceIn(),
  },
  outputs: Object.fromEntries(
    RIBBON_COLORS.map((c, k) => [
      `r${k + 1}`,
      output.line(`MA ${k + 1}`, c, { unit: 'price' as const, width: 1, legend: false }),
    ]),
  ) as Record<`r${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`, ReturnType<typeof output.line>>,
  title: (p) =>
    `${p.type.toUpperCase()} Ribbon ${p.start}+${p.step}×${p.count}${srcLabel(p.source)}`,
  calc(ctx) {
    const s = ctx.src(ctx.inputs.source);
    const o = ctx.out as unknown as Record<string, { v: Float64Array }>;
    for (let k = 0; k < ctx.inputs.count; k++) {
      const out = o[`r${k + 1}`]!.v;
      out[ctx.i] = maAt(
        ctx.inputs.type as MaType,
        out,
        s,
        ctx.i,
        ctx.inputs.start + k * ctx.inputs.step,
      );
    }
  },
});

export const MACross = defineIndicator({
  id: 'ma-cross',
  name: 'MA Cross',
  short: 'MA Cross',
  ...maMeta,
  description:
    'Fast and slow moving averages with a marker where the fast one crosses the slow one.',
  formula: 'Cross up: fast₋ ≤ slow₋ and fast > slow; cross down: fast₋ ≥ slow₋ and fast < slow',
  inputs: {
    type: input.enum('Type', 'ema', MA_TYPES),
    fast: input.int('Fast period', 9, { min: 1, max: 500 }),
    slow: input.int('Slow period', 21, { min: 2, max: 1000 }),
    source: sourceIn(),
  },
  outputs: {
    fast: output.line('Fast', HT.info, { unit: 'price', width: 1.5 }),
    slow: output.line('Slow', HT.warning, { unit: 'price', width: 1.5 }),
    cross: output.markers('Cross', HT.up, { color2: HT.down }),
  },
  title: (p) => `${p.type.toUpperCase()} Cross ${p.fast}/${p.slow}${srcLabel(p.source)}`,
  calc(ctx) {
    const s = ctx.src(ctx.inputs.source);
    const t = ctx.inputs.type as MaType;
    const f = ctx.out.fast.v;
    const sl = ctx.out.slow.v;
    const i = ctx.i;
    f[i] = maAt(t, f, s, i, ctx.inputs.fast);
    sl[i] = maAt(t, sl, s, i, ctx.inputs.slow);
    if (i === 0 || Number.isNaN(f[i - 1]! + sl[i - 1]! + f[i]! + sl[i]!)) return;
    const up = f[i - 1]! <= sl[i - 1]! && f[i]! > sl[i]!;
    const dn = f[i - 1]! >= sl[i - 1]! && f[i]! < sl[i]!;
    if (up || dn)
      ctx.out.cross.add({
        bar: i,
        value: sl[i]!,
        shape: up ? 'triangleUp' : 'triangleDown',
        size: 5,
        tone: up ? 0 : 1,
      } satisfies Marker);
  },
});

const GUPPY_SHORT = [3, 5, 8, 10, 12, 15];
const GUPPY_LONG = [30, 35, 40, 45, 50, 60];

export const Guppy = defineIndicator({
  id: 'guppy',
  name: 'Guppy Multiple Moving Average',
  short: 'GMMA',
  ...maMeta,
  description: 'Two groups of six EMAs: short-term traders (3–15) and long-term investors (30–60).',
  formula: 'Short: EMA 3, 5, 8, 10, 12, 15; Long: EMA 30, 35, 40, 45, 50, 60',
  inputs: { source: sourceIn() },
  outputs: {
    ...Object.fromEntries(
      GUPPY_SHORT.map((n, k) => [
        `s${k + 1}`,
        output.line(`EMA ${n}`, HT.up, {
          unit: 'price' as const,
          width: 1,
          legend: false,
          opacity: 0.85,
        }),
      ]),
    ),
    ...Object.fromEntries(
      GUPPY_LONG.map((n, k) => [
        `l${k + 1}`,
        output.line(`EMA ${n}`, HT.down, {
          unit: 'price' as const,
          width: 1.5,
          legend: false,
          opacity: 0.85,
        }),
      ]),
    ),
  } as Record<`${'s' | 'l'}${1 | 2 | 3 | 4 | 5 | 6}`, ReturnType<typeof output.line>>,
  title: (p) => `GMMA${srcLabel(p.source)}`,
  calc(ctx) {
    const s = ctx.src(ctx.inputs.source);
    const o = ctx.out as unknown as Record<string, { v: Float64Array }>;
    GUPPY_SHORT.forEach((n, k) => {
      const out = o[`s${k + 1}`]!.v;
      out[ctx.i] = ema(out, s, ctx.i, n);
    });
    GUPPY_LONG.forEach((n, k) => {
      const out = o[`l${k + 1}`]!.v;
      out[ctx.i] = ema(out, s, ctx.i, n);
    });
  },
});
