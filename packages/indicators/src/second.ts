import {
  HT,
  beta,
  defineIndicator,
  input,
  output,
  pearson,
  ratioOf,
  simpleReturn,
  spreadOf,
  type CalcContext,
  type InputDefs,
  type OutputDefs,
} from '@htflow/indicator-sdk';

const label = (id: string) => (id ? (id.split(':').pop() ?? id) : '?');
const symbolHelp =
  'Second instrument (picked with the symbol picker). Its bars use the chart timeframe and are aligned to this chart bar by bar; gaps keep the last known value.';

type Ctx = CalcContext<InputDefs, OutputDefs, unknown>;

/** The other instrument's aligned closes, or null with a legend note explaining why. */
function second(ctx: Ctx, id: string) {
  if (!id) {
    ctx.notice('pick a second instrument in the inputs');
    return null;
  }
  const a = ctx.aux(id);
  if (!a) {
    ctx.notice(`waiting for ${label(id)}`);
    return null;
  }
  return a;
}

/**
 * Spread (two instruments, Appendix B Misc): this chart's price minus k times the second
 * instrument's price (real prices, not ticks), or the percentage difference.
 */
export const Spread = defineIndicator({
  id: 'spread',
  name: 'Spread (two instruments)',
  short: 'Spread',
  category: 'technical',
  group: 'Misc',
  pane: 'new',
  needsHost: true,
  zeroLine: true,
  description:
    'Price of this chart minus the price of a second instrument (optionally scaled), computed bar by bar on aligned closes.',
  formula:
    'Spread = C - k·C₂ (real prices); percent mode: 100·(C / (k·C₂) − 1). C₂ = close of the second instrument at or before the bar open (gaps are forward-filled)',
  inputs: {
    symbol: input.instrument('Second instrument', '', { help: symbolHelp }),
    k: input.float('Multiplier k', 1, {
      min: -1e6,
      max: 1e6,
      step: 0.1,
      help: 'Weight of the second instrument (hedge ratio).',
    }),
    mode: input.enum(
      'Mode',
      'diff',
      [
        ['diff', 'Difference (price)'],
        ['percent', 'Percent difference'],
      ],
      { help: 'Difference is shown in price units of this chart.' },
    ),
  },
  outputs: { spread: output.line('Spread', HT.info, { unit: 'price' }) },
  title: (p) => `Spread vs ${label(p.symbol)}${p.k !== 1 ? ` ×${p.k}` : ''}`,
  calc(ctx) {
    const a = second(ctx, ctx.inputs.symbol);
    if (!a) return;
    const host = ctx.bar.c * ctx.tickSize;
    const aux = a.close[ctx.i]!;
    if (ctx.inputs.mode === 'percent') {
      const r = ratioOf(host, ctx.inputs.k * aux);
      if (!Number.isNaN(r)) ctx.out.spread.set(ctx.i, 100 * (r - 1));
      return;
    }
    const v = spreadOf(host, aux, ctx.inputs.k);
    if (!Number.isNaN(v)) ctx.out.spread.set(ctx.i, v / ctx.tickSize);
  },
});

export const Ratio = defineIndicator({
  id: 'ratio',
  name: 'Ratio',
  short: 'Ratio',
  category: 'technical',
  group: 'Misc',
  pane: 'new',
  needsHost: true,
  description: 'Price of this chart divided by the price of a second instrument.',
  formula: 'Ratio = C / C₂ (real prices; NaN when C₂ = 0 or missing)',
  inputs: {
    symbol: input.instrument('Second instrument', '', { help: symbolHelp }),
  },
  outputs: { ratio: output.line('Ratio', HT.warning) },
  title: (p) => `Ratio to ${label(p.symbol)}`,
  calc(ctx) {
    const a = second(ctx, ctx.inputs.symbol);
    if (!a) return;
    const v = ratioOf(ctx.bar.c * ctx.tickSize, a.close[ctx.i]!);
    if (!Number.isNaN(v)) ctx.out.ratio.set(ctx.i, v);
  },
});

const LENGTH_HELP = 'Number of bars in the rolling window.';

export const Correlation = defineIndicator({
  id: 'correlation',
  name: 'Correlation',
  short: 'Corr',
  category: 'technical',
  group: 'Misc',
  pane: 'new',
  needsHost: true,
  range: [-1, 1],
  zeroLine: true,
  description:
    'Rolling Pearson correlation between this chart and a second instrument (of bar-to-bar returns by default).',
  formula:
    'ρ = cov(x, y) / (σx·σy) over the last n bars; x, y = simple returns C/C₋₁ − 1 (or the prices themselves)',
  inputs: {
    symbol: input.instrument('Second instrument', '', { help: symbolHelp }),
    length: input.int('Length', 20, { min: 2, max: 500, help: LENGTH_HELP }),
    on: input.enum(
      'Computed on',
      'returns',
      [
        ['returns', 'Returns'],
        ['prices', 'Prices'],
      ],
      { help: 'Returns are what traders mean by correlation; price levels correlate spuriously.' },
    ),
  },
  outputs: { corr: output.line('Correlation', HT.special) },
  guides: () => [0.5, -0.5],
  title: (p) => `Correlation ${label(p.symbol)} (${p.length})`,
  calc(ctx) {
    const a = second(ctx, ctx.inputs.symbol);
    if (!a) return;
    const { i } = ctx;
    const n = ctx.inputs.length;
    let v: number;
    if (ctx.inputs.on === 'prices') {
      const host = ctx.buf('host');
      host[i] = ctx.bar.c * ctx.tickSize;
      v = pearson(host, a.close, i, n);
    } else {
      const c = ctx.src('close');
      const ra = ctx.buf('ra');
      const rb = ctx.buf('rb');
      ra[i] = simpleReturn(c, i);
      rb[i] = simpleReturn(a.close, i);
      v = pearson(ra, rb, i, n);
    }
    if (!Number.isNaN(v)) ctx.out.corr.set(ctx.i, v);
  },
});

export const Beta = defineIndicator({
  id: 'beta',
  name: 'Beta',
  short: 'Beta',
  category: 'technical',
  group: 'Misc',
  pane: 'new',
  needsHost: true,
  description:
    'Rolling beta of this chart against a second (benchmark) instrument: how many percent it moves per percent of the benchmark.',
  formula: 'β = cov(r, r₂) / var(r₂) over the last n bars; r, r₂ = simple returns C/C₋₁ − 1',
  inputs: {
    symbol: input.instrument('Benchmark instrument', '', { help: symbolHelp }),
    length: input.int('Length', 20, { min: 2, max: 500, help: LENGTH_HELP }),
  },
  outputs: { beta: output.line('Beta', HT.up) },
  guides: () => [1, 0],
  title: (p) => `Beta vs ${label(p.symbol)} (${p.length})`,
  calc(ctx) {
    const a = second(ctx, ctx.inputs.symbol);
    if (!a) return;
    const { i } = ctx;
    const ra = ctx.buf('ra');
    const rb = ctx.buf('rb');
    ra[i] = simpleReturn(ctx.src('close'), i);
    rb[i] = simpleReturn(a.close, i);
    const v = beta(ra, rb, i, ctx.inputs.length);
    if (!Number.isNaN(v)) ctx.out.beta.set(ctx.i, v);
  },
});
