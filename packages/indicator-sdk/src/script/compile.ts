/**
 * HT Script interpreter: turns a parsed script into an IndicatorDefinition.
 *
 * Sandbox by construction: names resolve only to the built-ins below (bar sources, math and
 * series functions, `input.*` / `plot.*` declarations) or to the script's own variables. Unknown
 * names (`fetch`, `window`, `document`, `self`, `globalThis`, `constructor`, …) are compile errors;
 * there is no member access, no loops, no recursion and no way to reach host objects.
 *
 * Every variable is a per-bar series kept in the runtime's scratch buffers, so recomputing the
 * last bar any number of times gives the same result as a full recompute (SDK incremental
 * contract), and `x[1]` reads the previous bar. Prices are real prices in scripts (ticks ×
 * tickSize); outputs with unit "price" are stored back in ticks for the chart's price scale.
 */
import { ListOut, SeriesOut } from '../buffers';
import * as m from '../math';
import type {
  AnyIndicator,
  CalcContext,
  InputDef,
  InputDefs,
  InputValue,
  Marker,
  OutputDef,
  OutputDefs,
  OutputKind,
  PaneKind,
  SourceId,
  ValueUnit,
} from '../types';
import { SOURCES } from '../types';
import { isColor } from '../inputs';
import { parseExpression, parseProgram, ScriptError, type Expr, type Pos, type Stmt } from './lang';

export { ScriptError } from './lang';

type Ctx = CalcContext<InputDefs, OutputDefs, unknown>;

const PRICE_SOURCES: SourceId[] = ['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4'];
const BAR_SOURCES: SourceId[] = SOURCES.map((s) => s.value);

/** Series / math functions: name → [min args, max args]. */
const FUNCS: Record<string, [number, number]> = {
  sma: [2, 2],
  ema: [2, 2],
  rma: [2, 2],
  wma: [2, 2],
  sum: [2, 2],
  highest: [2, 2],
  lowest: [2, 2],
  stdev: [2, 2],
  change: [1, 2],
  roc: [2, 2],
  rsi: [2, 2],
  cum: [1, 1],
  crossover: [2, 2],
  crossunder: [2, 2],
  barssince: [1, 1],
  atr: [1, 1],
  abs: [1, 1],
  min: [2, 8],
  max: [2, 8],
  sqrt: [1, 1],
  log: [1, 1],
  log10: [1, 1],
  exp: [1, 1],
  pow: [2, 2],
  round: [1, 1],
  floor: [1, 1],
  ceil: [1, 1],
  sign: [1, 1],
  nz: [1, 2],
  na: [1, 1],
};

/** Every built-in name a script can use (shown in the editor's reference). */
export const SCRIPT_BUILTINS = {
  variables: [...BAR_SOURCES, 'bar_index', 'time', 'tick', 'na', 'true', 'false'],
  functions: Object.keys(FUNCS),
  declarations: [
    'indicator',
    'input.int',
    'input.float',
    'input.bool',
    'input.source',
    'plot',
    'plot.line',
    'plot.step',
    'plot.area',
    'plot.histogram',
    'plot.dots',
    'plot.band',
    'plot.marker',
    'hline',
  ],
};

const PLOT_KINDS: Record<string, OutputKind> = {
  plot: 'line',
  'plot.line': 'line',
  'plot.step': 'step',
  'plot.area': 'area',
  'plot.histogram': 'histogram',
  'plot.dots': 'dots',
  'plot.band': 'band',
  'plot.marker': 'markers',
};
const UNITS: ValueUnit[] = ['price', 'value', 'volume', 'percent', 'count'];
const SHAPES: Marker['shape'][] = [
  'circle',
  'square',
  'triangleUp',
  'triangleDown',
  'diamond',
  'text',
];
const DEFAULT_COLORS = ['#4FA3F7', '#E8B04B', '#B07CF0', '#FFFFFF', '#20C77A', '#F04A5D'];

export interface ScriptMeta {
  name: string;
  short: string;
  pane: PaneKind;
  description: string;
}

interface PlotSpec {
  key: string;
  kind: OutputKind;
  call: Expr & { t: 'call' };
  unit: ValueUnit;
  hasColor2: boolean;
}

/** A compiled script: its declarations plus a per-bar evaluator. */
export interface ScriptProgram {
  meta: ScriptMeta;
  inputs: InputDefs;
  outputs: OutputDefs;
  guides: number[];
  /** Evaluates the whole script for bar ctx.i. */
  run(ctx: Ctx): void;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 32) || 'x';

function err(msg: string, pos: Pos | null): never {
  throw new ScriptError(msg, pos);
}

/** Literal value of a declaration argument (strings, numbers incl. unary minus, true/false). */
function literal(e: Expr | undefined, what: string): string | number | boolean | undefined {
  if (!e) return undefined;
  if (e.t === 'num' || e.t === 'str') return e.v;
  if (e.t === 'unary' && e.op === '-' && e.e.t === 'num') return -e.e.v;
  if (e.t === 'name' && (e.name === 'true' || e.name === 'false')) return e.name === 'true';
  return err(`${what} must be a literal value`, e.pos);
}
const litStr = (e: Expr | undefined, what: string, def?: string): string => {
  const v = literal(e, what);
  if (v === undefined && def !== undefined) return def;
  if (typeof v !== 'string') return err(`${what} must be a string`, e?.pos ?? null);
  return v;
};
const litNum = (e: Expr | undefined, what: string, def?: number): number => {
  const v = literal(e, what);
  if (v === undefined && def !== undefined) return def;
  if (typeof v !== 'number') return err(`${what} must be a number`, e?.pos ?? null);
  return v;
};

function walk(e: Expr, fn: (e: Expr) => void): void {
  fn(e);
  switch (e.t) {
    case 'call':
      e.args.forEach((a) => walk(a, fn));
      Object.values(e.named).forEach((a) => walk(a, fn));
      break;
    case 'unary':
      walk(e.e, fn);
      break;
    case 'bin':
      walk(e.a, fn);
      walk(e.b, fn);
      break;
    case 'cond':
      walk(e.c, fn);
      walk(e.a, fn);
      walk(e.b, fn);
      break;
    case 'index':
      walk(e.e, fn);
      walk(e.n, fn);
      break;
    default:
  }
}

const NAMED_OK: Record<string, string[]> = {
  indicator: ['short', 'pane', 'description'],
  'input.int': ['min', 'max', 'step', 'help'],
  'input.float': ['min', 'max', 'step', 'help'],
  'input.bool': ['help'],
  'input.source': ['help'],
  plot: ['color', 'color2', 'width', 'unit', 'tone', 'kind'],
  'plot.line': ['color', 'color2', 'width', 'unit', 'tone'],
  'plot.step': ['color', 'color2', 'width', 'unit', 'tone'],
  'plot.area': ['color', 'color2', 'width', 'unit', 'tone'],
  'plot.histogram': ['color', 'color2', 'width', 'unit', 'tone'],
  'plot.dots': ['color', 'color2', 'width', 'unit', 'tone'],
  'plot.band': ['color', 'color2', 'unit'],
  'plot.marker': ['color', 'color2', 'shape', 'text', 'size', 'tone', 'unit'],
  hline: [],
};

/**
 * Compiles a statement list (and an optional pane default) into a program.
 * `extraNames` are host variables (Custom Formula has none).
 */
function build(stmts: Stmt[], opts: { defaultName: string }): ScriptProgram {
  const meta: ScriptMeta = {
    name: opts.defaultName,
    short: '',
    pane: 'new',
    description: 'User script',
  };
  let sawIndicator = false;
  // Pass 1: indicator() first (pane decides default plot units), then validation.
  for (const s of stmts)
    if (s.t === 'expr' && s.e.t === 'call' && s.e.name === 'indicator') {
      if (sawIndicator) err('indicator() may appear only once', s.pos);
      sawIndicator = true;
      const c = s.e;
      meta.name = litStr(c.args[0], 'Indicator name').slice(0, 60) || opts.defaultName;
      meta.short = litStr(c.named.short ?? c.args[1], 'short', '').slice(0, 16);
      const pane = litStr(c.named.pane ?? c.args[2], 'pane', 'new');
      if (pane !== 'overlay' && pane !== 'new') err('pane must be "overlay" or "new"', c.pos);
      meta.pane = pane;
      meta.description = litStr(c.named.description, 'description', meta.description).slice(0, 200);
    }

  const inputs: InputDefs = {};
  const inputKey = new Map<number, string>();
  const outputs: OutputDefs = {};
  const plots: PlotSpec[] = [];
  const guides: number[] = [];
  const declared = new Set<string>();
  let colorIx = 0;

  const checkExpr = (e: Expr, topLevelStmt: boolean) =>
    walk(e, (n) => {
      if (n.t === 'name') {
        if (BAR_SOURCES.includes(n.name as SourceId)) return;
        if (['bar_index', 'time', 'tick', 'na', 'true', 'false'].includes(n.name)) return;
        if (!declared.has(n.name)) err(`Unknown name '${n.name}'`, n.pos);
        return;
      }
      if (n.t !== 'call') return;
      const isDecl = n.name in NAMED_OK;
      if (isDecl) {
        if (n.name.startsWith('input.')) {
          if (n !== e || topLevelStmt) err('Assign inputs to a name: len = input.int(…)', n.pos);
        } else if (n !== e || !topLevelStmt) err(`${n.name}() must be its own statement`, n.pos);
        for (const k of Object.keys(n.named))
          if (!NAMED_OK[n.name]!.includes(k)) err(`${n.name}() has no argument '${k}'`, n.pos);
        return;
      }
      const sig = FUNCS[n.name];
      if (!sig) err(`Unknown function '${n.name}'`, n.pos);
      if (Object.keys(n.named).length) err(`${n.name}() takes no named arguments`, n.pos);
      if (n.args.length < sig[0] || n.args.length > sig[1])
        err(
          `${n.name}() takes ${sig[0] === sig[1] ? sig[0] : `${sig[0]}–${sig[1]}`} arguments`,
          n.pos,
        );
    });

  for (const s of stmts) {
    if (s.t === 'assign') {
      if (BAR_SOURCES.includes(s.name as SourceId) || s.name in FUNCS || s.name === 'tick')
        err(`'${s.name}' is a built-in name`, s.pos);
      if (s.reassign && !declared.has(s.name))
        err(`'${s.name}' must be declared before ':='`, s.pos);
      if (!s.reassign && declared.has(s.name))
        err(`'${s.name}' is already declared (use ':=' to reassign)`, s.pos);
      if (s.persist) declared.add(s.name);
      checkExpr(s.e, false);
      declared.add(s.name);
      const c = s.e;
      if (c.t === 'call' && c.name.startsWith('input.')) {
        const label = litStr(c.args[0], 'Input label').slice(0, 40);
        const key = slug(label);
        if (inputs[key]) err(`Duplicate input '${label}'`, c.pos);
        const help = c.named.help ? litStr(c.named.help, 'help') : undefined;
        let d: InputDef;
        if (c.name === 'input.int' || c.name === 'input.float') {
          const int = c.name === 'input.int';
          const def = litNum(c.args[1], 'Default value');
          const min = litNum(c.named.min ?? c.args[2], 'min', int ? 1 : -1e9);
          const max = litNum(c.named.max ?? c.args[3], 'max', int ? 5000 : 1e9);
          const step = litNum(c.named.step, 'step', int ? 1 : 0.1);
          if (!(min <= def && def <= max)) err('Default must lie within min..max', c.pos);
          d = { type: int ? 'int' : 'float', label, default: def, min, max, step, help };
        } else if (c.name === 'input.bool') {
          const def = literal(c.args[1], 'Default value');
          if (typeof def !== 'boolean') err('Default must be true or false', c.pos);
          d = { type: 'bool', label, default: def, help };
        } else if (c.name === 'input.source') {
          const def = litStr(c.args[1], 'Default source', 'close');
          if (!BAR_SOURCES.includes(def as SourceId)) err(`Unknown source '${def}'`, c.pos);
          d = { type: 'source', label, default: def as SourceId, help };
        } else return err(`Unknown input type '${c.name}'`, c.pos);
        inputs[key] = d;
        inputKey.set(c.id, key);
      }
      continue;
    }
    const e = s.e;
    checkExpr(e, true);
    if (e.t !== 'call') continue;
    if (e.name === 'hline') {
      guides.push(litNum(e.args[0], 'hline value'));
      continue;
    }
    const kindName =
      e.name === 'plot' && e.named.kind ? `plot.${litStr(e.named.kind, 'kind')}` : e.name;
    const kind = PLOT_KINDS[kindName];
    if (!kind) continue;
    const label = litStr(e.args[0], 'Plot label').slice(0, 32);
    const key = slug(label);
    if (outputs[key]) err(`Duplicate plot '${label}'`, e.pos);
    if (plots.length >= 32) err('At most 32 plots', e.pos);
    const need = kind === 'band' ? 3 : kind === 'markers' ? 2 : 2;
    if (e.args.length < need) err(`${e.name}() needs ${need} arguments`, e.pos);
    const color = e.named.color ? litStr(e.named.color, 'color') : DEFAULT_COLORS[colorIx++ % 6]!;
    const color2 = e.named.color2 ? litStr(e.named.color2, 'color2') : undefined;
    if (!isColor(color) || (color2 !== undefined && !isColor(color2)))
      err('Colours are "#RRGGBB" or "#RRGGBBAA"', e.pos);
    const unit = litStr(e.named.unit, 'unit', meta.pane === 'overlay' ? 'price' : 'value');
    if (!UNITS.includes(unit as ValueUnit)) err(`unit must be one of ${UNITS.join(', ')}`, e.pos);
    if (e.named.shape) {
      const sh = litStr(e.named.shape, 'shape');
      if (!SHAPES.includes(sh as Marker['shape']))
        err(`shape must be one of ${SHAPES.join(', ')}`, e.pos);
    }
    const width = e.named.width ? litNum(e.named.width, 'width') : undefined;
    const od: OutputDef = { kind, label, color, unit: unit as ValueUnit };
    if (color2) od.color2 = color2;
    if (width !== undefined) od.width = Math.min(8, Math.max(0.5, width));
    if (kind === 'band') od.opacity = 0.25;
    outputs[key] = od;
    plots.push({ key, kind, call: e, unit: unit as ValueUnit, hasColor2: !!color2 });
  }
  if (Object.keys(inputs).length > 32) err('At most 32 inputs', null);
  if (!plots.length) err('The script plots nothing: add plot("Label", value)', null);
  if (!meta.short) meta.short = meta.name.slice(0, 16);

  return { meta, inputs, outputs, guides, run: makeRunner(stmts, plots, inputKey) };
}

// ------------------------------------------------------------------ evaluation

function makeRunner(
  stmts: Stmt[],
  plots: PlotSpec[],
  inputKey: Map<number, string>,
): (ctx: Ctx) => void {
  const plotByCall = new Map(plots.map((p) => [p.call.id, p]));
  const nan = Number.NaN;
  const truthy = (x: number) => !Number.isNaN(x) && x !== 0;

  return (ctx: Ctx) => {
    const i = ctx.i;
    const tick = ctx.tickSize;
    const srcVal = (id: SourceId, k: number): number => {
      if (k < 0) return nan;
      const v = ctx.src(id)[k]!;
      return PRICE_SOURCES.includes(id) ? v * tick : v;
    };
    const varBuf = (name: string) => ctx.buf(`v:${name}`);
    const nodeBuf = (id: number, tag: string) => ctx.buf(`n${id}${tag}`);
    const intArg = (e: Expr): number => {
      const n = Math.round(ev(e));
      return Number.isFinite(n) ? Math.min(5000, Math.max(1, n)) : 1;
    };
    /** Evaluates e at bar i and stores it in the call-site buffer (for series functions). */
    const series = (e: Expr, id: number, tag: string): Float64Array => {
      const b = nodeBuf(id, tag);
      b[i] = ev(e);
      return b;
    };

    const call = (e: Expr & { t: 'call' }): number => {
      const a = e.args;
      if (e.name.startsWith('input.')) {
        const key = inputKey.get(e.id)!;
        const v = (ctx.inputs as Record<string, InputValue>)[key];
        if (e.name === 'input.source') return srcVal(v as SourceId, i);
        if (typeof v === 'boolean') return v ? 1 : 0;
        return typeof v === 'number' ? v : nan;
      }
      switch (e.name) {
        case 'sma':
          return m.sma(series(a[0]!, e.id, 'a'), i, intArg(a[1]!));
        case 'sum':
          return m.sum(series(a[0]!, e.id, 'a'), i, intArg(a[1]!));
        case 'wma':
          return m.wma(series(a[0]!, e.id, 'a'), i, intArg(a[1]!));
        case 'highest':
          return m.highest(series(a[0]!, e.id, 'a'), i, intArg(a[1]!));
        case 'lowest':
          return m.lowest(series(a[0]!, e.id, 'a'), i, intArg(a[1]!));
        case 'stdev':
          return m.stdev(series(a[0]!, e.id, 'a'), i, intArg(a[1]!));
        case 'ema':
        case 'rma': {
          const s = series(a[0]!, e.id, 'a');
          const o = nodeBuf(e.id, 'o');
          o[i] = (e.name === 'ema' ? m.ema : m.rma)(o, s, i, intArg(a[1]!));
          return o[i]!;
        }
        case 'change':
        case 'roc': {
          const s = series(a[0]!, e.id, 'a');
          const n = a[1] ? intArg(a[1]) : 1;
          const p = i - n >= 0 ? s[i - n]! : nan;
          return e.name === 'change' ? s[i]! - p : p === 0 ? nan : ((s[i]! - p) / p) * 100;
        }
        case 'rsi': {
          const s = series(a[0]!, e.id, 'a');
          const n = intArg(a[1]!);
          const up = nodeBuf(e.id, 'u');
          const dn = nodeBuf(e.id, 'd');
          const au = nodeBuf(e.id, 'U');
          const ad = nodeBuf(e.id, 'D');
          const ch = i > 0 ? s[i]! - s[i - 1]! : nan;
          up[i] = Number.isNaN(ch) ? nan : Math.max(ch, 0);
          dn[i] = Number.isNaN(ch) ? nan : Math.max(-ch, 0);
          au[i] = m.rma(au, up, i, n);
          ad[i] = m.rma(ad, dn, i, n);
          const u = au[i]!;
          const d = ad[i]!;
          if (Number.isNaN(u) || Number.isNaN(d)) return nan;
          return d === 0 ? 100 : 100 - 100 / (1 + u / d);
        }
        case 'cum': {
          const o = nodeBuf(e.id, 'o');
          const x = ev(a[0]!);
          const p = i > 0 ? o[i - 1]! : 0;
          o[i] = (Number.isNaN(p) ? 0 : p) + (Number.isNaN(x) ? 0 : x);
          return o[i]!;
        }
        case 'crossover':
        case 'crossunder': {
          const x = series(a[0]!, e.id, 'a');
          const y = series(a[1]!, e.id, 'b');
          return (e.name === 'crossover' ? m.crossOver : m.crossUnder)(x, y, i) ? 1 : 0;
        }
        case 'barssince': {
          const o = nodeBuf(e.id, 'o');
          const c = truthy(ev(a[0]!));
          o[i] = c ? 0 : i > 0 && !Number.isNaN(o[i - 1]!) ? o[i - 1]! + 1 : nan;
          return o[i]!;
        }
        case 'atr': {
          const tr = nodeBuf(e.id, 'a');
          const o = nodeBuf(e.id, 'o');
          const b = ctx.bar;
          tr[i] = m.trueRange(b.h, b.l, i > 0 ? ctx.bars[i - 1]!.c : Number.NaN) * tick;
          o[i] = m.rma(o, tr, i, intArg(a[0]!));
          return o[i]!;
        }
        case 'abs':
          return Math.abs(ev(a[0]!));
        case 'min':
          return Math.min(...a.map(ev));
        case 'max':
          return Math.max(...a.map(ev));
        case 'sqrt':
          return Math.sqrt(ev(a[0]!));
        case 'log':
          return Math.log(ev(a[0]!));
        case 'log10':
          return Math.log10(ev(a[0]!));
        case 'exp':
          return Math.exp(ev(a[0]!));
        case 'pow':
          return Math.pow(ev(a[0]!), ev(a[1]!));
        case 'round':
          return Math.round(ev(a[0]!));
        case 'floor':
          return Math.floor(ev(a[0]!));
        case 'ceil':
          return Math.ceil(ev(a[0]!));
        case 'sign':
          return Math.sign(ev(a[0]!));
        case 'nz': {
          const x = ev(a[0]!);
          return Number.isNaN(x) ? (a[1] ? ev(a[1]) : 0) : x;
        }
        case 'na':
          return Number.isNaN(ev(a[0]!)) ? 1 : 0;
        default:
          return nan;
      }
    };

    const ev = (e: Expr): number => {
      switch (e.t) {
        case 'num':
          return e.v;
        case 'str':
          return nan;
        case 'name':
          switch (e.name) {
            case 'bar_index':
              return i;
            case 'time':
              return ctx.bar.t;
            case 'tick':
              return tick;
            case 'na':
              return nan;
            case 'true':
              return 1;
            case 'false':
              return 0;
          }
          if (BAR_SOURCES.includes(e.name as SourceId)) return srcVal(e.name as SourceId, i);
          return varBuf(e.name)[i]!;
        case 'unary': {
          const x = ev(e.e);
          return e.op === '-' ? -x : e.op === '+' ? x : truthy(x) ? 0 : 1;
        }
        case 'bin': {
          if (e.op === '&&') return truthy(ev(e.a)) && truthy(ev(e.b)) ? 1 : 0;
          if (e.op === '||') return truthy(ev(e.a)) || truthy(ev(e.b)) ? 1 : 0;
          const x = ev(e.a);
          const y = ev(e.b);
          switch (e.op) {
            case '+':
              return x + y;
            case '-':
              return x - y;
            case '*':
              return x * y;
            case '/':
              return y === 0 ? nan : x / y;
            case '%':
              return y === 0 ? nan : x % y;
            case '^':
              return Math.pow(x, y);
            case '==':
              return x === y ? 1 : 0;
            case '!=':
              return x !== y ? 1 : 0;
            case '<':
              return x < y ? 1 : 0;
            case '<=':
              return x <= y ? 1 : 0;
            case '>':
              return x > y ? 1 : 0;
            case '>=':
              return x >= y ? 1 : 0;
          }
          return nan;
        }
        case 'cond': {
          // Both branches are evaluated so series functions inside them see every bar.
          const c = truthy(ev(e.c));
          const a = ev(e.a);
          const b = ev(e.b);
          return c ? a : b;
        }
        case 'index': {
          const n = Math.round(ev(e.n));
          if (!Number.isFinite(n) || n < 0) return nan;
          const t = e.e;
          if (t.t === 'name' && BAR_SOURCES.includes(t.name as SourceId))
            return srcVal(t.name as SourceId, i - n);
          if (
            t.t === 'name' &&
            !['bar_index', 'time', 'tick', 'na', 'true', 'false'].includes(t.name)
          )
            return i - n >= 0 ? varBuf(t.name)[i - n]! : nan;
          const b = series(t, e.id, 'x');
          return i - n >= 0 ? b[i - n]! : nan;
        }
        case 'call':
          return call(e);
      }
    };

    const out = ctx.out as unknown as Record<string, SeriesOut | ListOut<Marker>>;
    for (const s of stmts) {
      if (s.t === 'assign') {
        const b = varBuf(s.name);
        if (s.persist) b[i] = i > 0 ? b[i - 1]! : ev(s.e);
        else b[i] = ev(s.e);
        continue;
      }
      const e = s.e;
      if (e.t !== 'call') {
        ev(e);
        continue;
      }
      const p = plotByCall.get(e.id);
      if (!p) {
        if (e.name !== 'indicator' && e.name !== 'hline') ev(e);
        continue;
      }
      const k = p.unit === 'price' ? 1 / tick : 1;
      const o = out[p.key]!;
      if (p.kind === 'markers') {
        const cond = truthy(ev(e.args[1]!));
        const val = e.args[2] ? ev(e.args[2]) : ctx.bar.c * tick;
        if (!cond || Number.isNaN(val)) continue;
        (o as ListOut<Marker>).add({
          bar: i,
          value: e.args[2] ? val * k : ctx.bar.c,
          shape: (e.named.shape?.t === 'str' ? e.named.shape.v : 'triangleUp') as Marker['shape'],
          size: e.named.size ? Math.min(20, Math.max(0, ev(e.named.size))) : 0,
          text: e.named.text?.t === 'str' ? e.named.text.v.slice(0, 24) : undefined,
          tone: e.named.tone ? Math.max(0, Math.min(2, Math.round(ev(e.named.tone)))) : 0,
          textPos: 'above',
        });
        continue;
      }
      const so = o as SeriesOut;
      if (p.kind === 'band') {
        so.setPair(i, ev(e.args[1]!) * k, ev(e.args[2]!) * k);
        continue;
      }
      const v = ev(e.args[1]!);
      const tone = e.named.tone
        ? Math.max(0, Math.min(2, Math.round(ev(e.named.tone)) || 0))
        : p.hasColor2 && v < 0
          ? 1
          : 0;
      so.set(i, v * k, tone);
    }
  };
}

// ------------------------------------------------------------------ public API

/** Parses + validates a script. Throws ScriptError with line:col on the first problem. */
export function compileScript(source: string, defaultName = 'Script'): ScriptProgram {
  return build(parseProgram(source), { defaultName });
}

/** Non-throwing variant for editors. */
export function checkScript(
  source: string,
): { ok: true; program: ScriptProgram } | { ok: false; error: string; pos: Pos | null } {
  try {
    return { ok: true, program: compileScript(source) };
  } catch (e) {
    if (e instanceof ScriptError) return { ok: false, error: e.message, pos: e.pos };
    return { ok: false, error: e instanceof Error ? e.message : String(e), pos: null };
  }
}

/** Builds an indicator definition from script source (`id` must be unique, e.g. "script:<slug>"). */
export function scriptIndicator(id: string, source: string, defaultName = 'Script'): AnyIndicator {
  const prog = compileScript(source, defaultName);
  return {
    id,
    name: prog.meta.name,
    short: prog.meta.short,
    category: 'custom',
    pane: prog.meta.pane,
    description: prog.meta.description,
    formula: 'HT Script (.htind)',
    overlayScale: 'merged',
    inputs: prog.inputs,
    outputs: prog.outputs,
    guides: prog.guides.length ? () => prog.guides.slice() : undefined,
    calc: (ctx) => prog.run(ctx as Ctx),
  };
}

/**
 * Custom Formula (P14): one expression in the same language, e.g.
 * `(close - sma(close, 20)) / stdev(close, 20)`. Returns the evaluator for a single value.
 */
export function compileFormula(text: string): (ctx: Ctx) => number {
  const e = parseExpression(text);
  const stmts: Stmt[] = [
    {
      t: 'expr',
      pos: e.pos,
      e: {
        t: 'call',
        name: 'plot',
        args: [{ t: 'str', v: 'v', pos: e.pos, id: -1 }, e],
        named: {},
        pos: e.pos,
        id: -2,
      },
    },
  ];
  const prog = build(stmts, { defaultName: 'Formula' });
  const out = new SeriesOut('line');
  return (ctx) => {
    if (out.capacity <= ctx.i) out.ensure(Math.max(256, (ctx.i + 1) * 2));
    const fake = { ...ctx, out: { v: out } } as unknown as Ctx;
    prog.run(fake);
    return out.v[ctx.i]!;
  };
}
