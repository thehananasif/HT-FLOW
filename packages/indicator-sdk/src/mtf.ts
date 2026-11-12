import type { Bar, Cluster } from '@htflow/market-data';
import type { SeriesOut} from './buffers';
import { isSeriesKind } from './buffers';
import { titleOf } from './config';
import { input } from './inputs';
import { periodStart } from './periods';
import { IndicatorRuntime } from './runtime';
import type {
  AnyIndicator,
  InputDefs,
  InputValue,
  OutputDefs,
  RawInputs,
  TimeframeId,
} from './types';

/** Timeframes a multi-timeframe indicator can be computed on. */
export const MTF_TIMEFRAMES = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D', 'W', 'MN'] as const;

export function cloneBar(b: Bar): Bar {
  const clusters = new Map<number, Cluster>();
  for (const [px, c] of b.clusters) clusters.set(px, { ...c });
  return { ...b, clusters };
}

/**
 * Folds the later bar `b` (same higher-timeframe period) into `a` in place: o stays, h/l extend,
 * c / tEnd follow `b`, volumes add and the delta wicks are the running extremes.
 */
export function mergeBar(a: Bar, b: Bar): Bar {
  a.maxDelta = Math.max(a.maxDelta, a.delta + b.maxDelta);
  a.minDelta = Math.min(a.minDelta, a.delta + b.minDelta);
  a.h = Math.max(a.h, b.h);
  a.l = Math.min(a.l, b.l);
  a.c = b.c;
  a.tEnd = b.tEnd;
  a.vol += b.vol;
  a.buy += b.buy;
  a.sell += b.sell;
  a.delta += b.delta;
  a.trades += b.trades;
  a.closed = b.closed;
  for (const [px, c] of b.clusters) {
    const x = a.clusters.get(px);
    if (!x) a.clusters.set(px, { ...c });
    else {
      x.bid += c.bid;
      x.ask += c.ask;
      x.trades += c.trades;
      x.maxTrade = Math.max(x.maxTrade, c.maxTrade);
      if (c.tap !== undefined) x.tap = (x.tap ?? 0) + c.tap;
    }
  }
  return a;
}

/** Aggregates time-ordered bars into higher-timeframe bars (reference implementation, tests). */
export function aggregateBars(bars: readonly Bar[], tf: TimeframeId): Bar[] {
  const out: Bar[] = [];
  let t = Number.NaN;
  for (const b of bars) {
    const p = periodStart(b.t, tf);
    if (p !== t) {
      const c = cloneBar(b);
      c.t = p;
      out.push(c);
      t = p;
    } else mergeBar(out[out.length - 1]!, b);
  }
  return out;
}

interface MtfState {
  rt: IndicatorRuntime;
  /** Higher-timeframe bars: completed periods, then one slot for the live bar. */
  arr: Bar[];
  nDone: number;
  /** Merge of the final chart bars of the current period (null before the first). */
  cur: Bar | null;
  curT: number;
  version: number;
}

/**
 * Wraps an indicator so it is computed on a higher timeframe and mapped back onto the chart's
 * bars. The higher-timeframe series is the chart's own bars (built from the same trades) merged
 * per period, so it equals what a BarSeries of that timeframe holds. Inputs: all of the base
 * indicator's inputs, plus the timeframe and `mtfMode`:
 * - `closed` (default): the value of the last COMPLETED higher-timeframe bar, never repaints;
 * - `live`: the value of the higher-timeframe bar forming up to the current chart bar.
 */
export function defineMtf(
  base: AnyIndicator,
  meta: { id: string; name: string; short: string; defaultTf?: TimeframeId },
): AnyIndicator {
  const outputs: OutputDefs = {};
  for (const [k, o] of Object.entries(base.outputs)) if (isSeriesKind(o.kind)) outputs[k] = o;
  const inputs: InputDefs = {
    mtfTimeframe: input.timeframe('Timeframe', meta.defaultTf ?? 'H1', {
      options: MTF_TIMEFRAMES,
      help: 'Higher timeframe the indicator is computed on.',
    }),
    mtfMode: input.enum(
      'Higher-timeframe bar',
      'closed',
      [
        ['closed', 'Last closed bar (no repaint)'],
        ['live', 'Forming bar (live)'],
      ],
      { help: 'Closed: value of the last completed bar. Live: value of the bar still forming.' },
    ),
    ...base.inputs,
  };
  const baseRaw = (p: object): RawInputs => {
    const raw: RawInputs = {};
    for (const k of Object.keys(base.inputs)) raw[k] = (p as Record<string, InputValue>)[k]!;
    return raw;
  };
  return {
    id: meta.id,
    name: meta.name,
    short: meta.short,
    category: base.category,
    group: base.group,
    pane: base.pane,
    description: `${base.name} computed on a higher timeframe and mapped onto the chart.`,
    formula: `${base.formula ?? base.name} — evaluated on higher-timeframe bars (chart bars merged per period).`,
    autoscale: base.autoscale,
    overlayScale: base.overlayScale,
    range: base.range,
    zeroLine: base.zeroLine,
    needsTrades: base.needsTrades,
    inputs,
    outputs,
    title: (p) => `MTF ${titleOf(base, baseRaw(p))} @${String(p.mtfTimeframe)}`,
    guides: base.guides ? (p) => base.guides!(p) : undefined,
    init(p): MtfState {
      return {
        rt: new IndicatorRuntime(base, baseRaw(p)),
        arr: [],
        nDone: 0,
        cur: null,
        curT: Number.NaN,
        version: 0,
      };
    },
    calc(ctx) {
      const s = ctx.state as MtfState;
      const tf = ctx.inputs.mtfTimeframe as TimeframeId;
      const bar = ctx.bar;
      const p = periodStart(bar.t, tf);
      if (s.cur && s.curT !== p) {
        // The committed period is complete (idempotent: a recompute of this bar sees cur === null).
        s.arr[s.nDone] = s.cur;
        s.nDone++;
        s.cur = null;
      }
      let live: Bar;
      if (ctx.final) {
        if (s.cur) live = mergeBar(s.cur, bar);
        else {
          live = s.cur = cloneBar(bar);
          s.cur.t = p;
          s.curT = p;
        }
      } else if (s.cur) live = mergeBar(cloneBar(s.cur), bar);
      else {
        live = cloneBar(bar);
        live.t = p;
      }
      s.arr.length = s.nDone + 1;
      s.arr[s.nDone] = live;
      s.version++;
      s.rt.update({ bars: s.arr, version: s.version, tickSize: ctx.tickSize });
      const n = s.rt.count;
      const idx = ctx.inputs.mtfMode === 'live' ? n - 1 : n - 2;
      if (idx < 0) return;
      for (const k of Object.keys(outputs)) {
        const from = s.rt.outputs[k] as SeriesOut;
        const to = (ctx.out as unknown as Record<string, SeriesOut>)[k]!;
        to.v[ctx.i] = from.v[idx]!;
        if (to.v2.length) to.v2[ctx.i] = from.v2[idx]!;
        if (to.v3.length) to.v3[ctx.i] = from.v3[idx]!;
        if (to.v4.length) to.v4[ctx.i] = from.v4[idx]!;
        to.tone[ctx.i] = from.tone[idx]!;
      }
    },
  };
}
