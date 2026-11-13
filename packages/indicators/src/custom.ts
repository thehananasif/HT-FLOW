import {
  HT,
  SAMPLE_SCRIPT,
  compileFormula,
  defineIndicator,
  input,
  output,
  scriptIndicator,
} from '@htflow/indicator-sdk';

type Evaluator = ReturnType<typeof compileFormula>;

/**
 * Custom Formula (Appendix B, Misc): one HT Script expression evaluated per bar, e.g.
 * `(close - sma(close, 20)) / stdev(close, 20)`. Same sandboxed interpreter as `.htind` scripts.
 */
export const CustomFormula = defineIndicator({
  id: 'custom-formula',
  name: 'Custom Formula',
  short: 'Formula',
  category: 'technical',
  group: 'Misc',
  pane: 'new',
  description:
    'Plots an expression of bar values and functions, e.g. (close - sma(close, 20)) / stdev(close, 20). Prices are real prices.',
  formula:
    'Names: open high low close hl2 hlc3 ohlc4 volume delta cvd buy sell trades bar_index tick; x[n] = n bars ago; sma ema rma wma sum highest lowest stdev change roc rsi cum atr crossover crossunder barssince abs min max sqrt log exp pow round floor ceil sign nz; + - * / % ^ < > == and or not ?:',
  inputs: {
    formula: input.string('Formula', '(close - sma(close, 20)) / stdev(close, 20)', {
      maxLength: 400,
      help: 'HT Script expression. Example: ema(delta, 10) - ema(delta, 30)',
    }),
    unit: input.enum(
      'Result is',
      'value',
      [
        ['value', 'A plain value'],
        ['price', 'A price (aligns with the price scale)'],
        ['volume', 'A volume'],
        ['percent', 'A percentage'],
      ],
      { help: 'How the result is formatted; "price" also lets it share the price scale.' },
    ),
  },
  outputs: {
    value: output.line('Formula', HT.info),
  },
  title: (p) => `ƒ ${p.formula.length > 32 ? `${p.formula.slice(0, 31)}…` : p.formula}`,
  init(p): { fn: Evaluator | null; error: string | null } {
    try {
      return { fn: compileFormula(p.formula), error: null };
    } catch (e) {
      return { fn: null, error: e instanceof Error ? e.message : String(e) };
    }
  },
  calc(ctx) {
    const s = ctx.state;
    if (!s.fn) {
      ctx.notice(s.error);
      return;
    }
    const v = s.fn(ctx as never);
    ctx.out.value.set(ctx.i, ctx.inputs.unit === 'price' ? v / ctx.tickSize : v);
  },
});

/** "Custom script (.htind)" catalog entry: the sample script; user scripts are added at run time. */
export const CustomScriptSample = scriptIndicator('custom-script', SAMPLE_SCRIPT, 'Delta momentum');
