import type { Bar } from '@htflow/market-data';
import { computeIndicator } from '../runtime';
import type { SeriesOut } from '../buffers';
import type { AnyIndicator } from '../types';
import { compileFormula } from './compile';
import { ScriptError, type Pos } from './lang';

export interface FormulaPreview {
  ok: true;
  /** The last `count` bars: bar open time and the formula's value (NaN while undefined). */
  rows: { t: number; value: number }[];
}
export interface FormulaFailure {
  ok: false;
  error: string;
  pos: Pos | null;
}

/** Most recent bars a preview evaluates (formulas only look back a bounded window). */
const PREVIEW_BARS = 1500;

/**
 * Live preview for the Custom Formula editor: evaluates the formula on the tail of `bars` (real
 * prices, like the indicator) and returns the last `count` values, or the parse error.
 */
export function previewFormula(
  text: string,
  bars: readonly Bar[],
  tickSize: number,
  count = 8,
): FormulaPreview | FormulaFailure {
  let fn: ReturnType<typeof compileFormula>;
  try {
    fn = compileFormula(text);
  } catch (e) {
    if (e instanceof ScriptError) return { ok: false, error: e.message, pos: e.pos };
    return { ok: false, error: e instanceof Error ? e.message : String(e), pos: null };
  }
  const tail = bars.length > PREVIEW_BARS ? bars.slice(bars.length - PREVIEW_BARS) : bars;
  const def: AnyIndicator = {
    id: 'formula-preview',
    name: 'Formula preview',
    category: 'technical',
    pane: 'new',
    description: '',
    inputs: {},
    outputs: { v: { kind: 'line', label: 'v', color: '#FFFFFF' } },
    calc: (ctx) => (ctx.out.v as SeriesOut).set(ctx.i, fn(ctx as never)),
  };
  const rt = computeIndicator(def, tail, undefined, { tickSize });
  const v = rt.series('v')!;
  const rows: FormulaPreview['rows'] = [];
  for (let i = Math.max(0, tail.length - count); i < tail.length; i++)
    rows.push({ t: tail[i]!.t, value: v.v[i]! });
  return { ok: true, rows };
}
