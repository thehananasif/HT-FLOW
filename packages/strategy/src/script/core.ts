import { IndicatorRuntime, type BarData, type RawInputs } from '@htflow/indicator-sdk';
import { indicatorById } from '@htflow/indicators';
import type { Bar } from '@htflow/market-data';
import { imbalancesOf, pocOf, stackedOf } from '../footprint';
import { SHADOWED_GLOBALS, forbiddenSyntax } from './hardening';
import {
  DEFAULT_LIMITS,
  HOOKS,
  parseTimeframe,
  type BracketIntent,
  type CallResult,
  type CompiledProject,
  type HookName,
  type HostEvent,
  type HostSnapshot,
  type InstrumentInfo,
  type LogEntry,
  type ParamDecl,
  type PlotPoint,
  type SandboxLimits,
  type ScriptDescription,
  type ScriptError,
  type ScriptIntent,
} from './protocol';
import { ta } from './ta';

// Captured before any realm lockdown: the core compiles user modules with it.
const RealFunction = Function;

/** Names the strategy API binds in every module (documented in docs/STRATEGY-API.md). */
export const API_NAMES = [
  'buy',
  'sell',
  'limit',
  'stop',
  'bracket',
  'close',
  'cancel',
  'cancelAll',
  'position',
  'account',
  'orders',
  'bars',
  'closes',
  'footprint',
  'delta',
  'cvd',
  'poc',
  'imbalances',
  'stackedImbalances',
  'book',
  'indicator',
  'ta',
  'param',
  'log',
  'warn',
  'plot',
  'time',
  'last',
  'canTrade',
  'instrument',
] as const;

const PARAM = Symbol.for('htflow.param');

/** `param.*` builders (plain data, tagged so the core can find them in `export const params`). */
export const param = {
  int: (label: string, def: number, o: { min?: number; max?: number; step?: number } = {}) =>
    ({ [PARAM]: true, type: 'int', label, default: def, ...o }) as unknown as number,
  float: (label: string, def: number, o: { min?: number; max?: number; step?: number } = {}) =>
    ({ [PARAM]: true, type: 'float', label, default: def, ...o }) as unknown as number,
  bool: (label: string, def: boolean) =>
    ({ [PARAM]: true, type: 'bool', label, default: def }) as unknown as boolean,
  choice: (label: string, def: string, options: string[]) =>
    ({ [PARAM]: true, type: 'choice', label, default: def, options }) as unknown as string,
  string: (label: string, def: string) =>
    ({ [PARAM]: true, type: 'string', label, default: def }) as unknown as string,
};

function asDecl(v: unknown): ParamDecl | null {
  if (!v || typeof v !== 'object' || !(v as Record<symbol, unknown>)[PARAM]) return null;
  const r = v as Record<string, unknown>;
  const label = String(r.label ?? '').slice(0, 64);
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
  switch (r.type) {
    case 'int':
    case 'float':
      return {
        type: r.type,
        label,
        default: num(r.default) ?? 0,
        min: num(r.min),
        max: num(r.max),
        step: num(r.step),
      };
    case 'bool':
      return { type: 'bool', label, default: r.default === true };
    case 'choice': {
      const options = Array.isArray(r.options) ? r.options.map(String).slice(0, 50) : [];
      const d = String(r.default ?? options[0] ?? '');
      return { type: 'choice', label, default: d, options: options.length ? options : [d] };
    }
    case 'string':
      return { type: 'string', label, default: String(r.default ?? '').slice(0, 256) };
    default:
      return null;
  }
}

/** Validates raw values against declarations (also used by the host's settings form). */
export function resolveParams(
  decls: Record<string, ParamDecl>,
  raw: Record<string, unknown> | undefined,
): Record<string, number | boolean | string> {
  const out: Record<string, number | boolean | string> = {};
  for (const [k, d] of Object.entries(decls)) {
    const v = raw?.[k];
    switch (d.type) {
      case 'int':
      case 'float': {
        let n = typeof v === 'number' && Number.isFinite(v) ? v : d.default;
        if (d.min !== undefined) n = Math.max(d.min, n);
        if (d.max !== undefined) n = Math.min(d.max, n);
        out[k] = d.type === 'int' ? Math.round(n) : n;
        break;
      }
      case 'bool':
        out[k] = typeof v === 'boolean' ? v : d.default;
        break;
      case 'choice':
        out[k] = typeof v === 'string' && d.options.includes(v) ? v : d.default;
        break;
      default:
        out[k] = typeof v === 'string' ? v.slice(0, 256) : d.default;
    }
  }
  return out;
}

type Factory = (...args: unknown[]) => () => void;

interface ModuleRec {
  factory: Factory;
  exports: Record<string, unknown>;
  state: 'new' | 'loading' | 'done';
}

interface Series {
  bars: Bar[];
  version: number;
  views: BarView[];
}

export interface BarView {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  buyVolume: number;
  sellVolume: number;
  delta: number;
  trades: number;
  index: number;
}

interface Frame {
  snapshot: HostSnapshot;
  /** Primary index visible to this call (bars after it are hidden). */
  index: number;
  intents: ScriptIntent[];
  logs: LogEntry[];
  plots: PlotPoint[];
  dropped: number;
}

const EMPTY_SNAPSHOT: HostSnapshot = {
  time: 0,
  last: Number.NaN,
  canTrade: false,
  position: { qty: 0, avgPx: 0, openPnl: 0 },
  account: { balance: 0, equity: 0, dayPnl: 0, currency: 'USD' },
  orders: [],
  book: null,
};

let lineOffset: number | null = null;

/** Lines the Function constructor + our wrapper add before user line 1 (engine-dependent). */
function calibrate(): number {
  if (lineOffset !== null) return lineOffset;
  try {
    const f = new RealFunction(
      'return (function(){"use strict";\nthrow new Error("probe");\n})\n//# sourceURL=htstrat-probe',
    ) as () => () => void;
    f()();
  } catch (e) {
    const m = /htstrat-probe:(\d+):(\d+)/.exec(String((e as Error).stack ?? ''));
    lineOffset = m ? Number(m[1]) - 1 : 2;
    return lineOffset;
  }
  lineOffset = 2;
  return lineOffset;
}

function safeFile(name: string): string {
  return name.replace(/[^\w./-]/g, '_').slice(0, 80);
}

/** Maps an error thrown by user code to a file / line (via the sourceURL of each module). */
export function locateError(e: unknown, kind: ScriptError['kind']): ScriptError {
  const err = e instanceof Error ? e : null;
  const message = (err ? `${err.name}: ${err.message}` : String(e)).slice(0, 500);
  const stack = String(err?.stack ?? '');
  const m = /htstrat\/([\w./-]+):(\d+):(\d+)/.exec(stack);
  if (!m) return { message, kind };
  return {
    message,
    kind,
    file: m[1],
    line: Math.max(1, Number(m[2]) - calibrate()),
    column: Number(m[3]),
  };
}

const r6 = (v: number) => Math.round(v * 1e8) / 1e8;

/**
 * The untrusted side of the HT Strategy API. Holds the user's modules, a mirror of the bars the
 * host sent, indicator runtimes and the API functions. Produces intents; never touches an order
 * engine. Runs inside the sandbox worker (and in-process for tests and the VPS runner).
 */
export class SandboxCore {
  readonly limits: SandboxLimits;
  private modules = new Map<string, ModuleRec>();
  private series = new Map<string, Series>();
  private inds = new Map<string, { rt: IndicatorRuntime; tf: string; scale: Set<string> }>();
  private hooks: Partial<Record<HookName, (arg?: unknown) => void>> = {};
  private frame: Frame = {
    snapshot: EMPTY_SNAPSHOT,
    index: -1,
    intents: [],
    logs: [],
    plots: [],
    dropped: 0,
  };
  private cid = 0;
  private api: Record<string, unknown>;
  private description: ScriptDescription | null = null;
  private stopped = false;

  constructor(
    readonly instrument: InstrumentInfo,
    limits: Partial<SandboxLimits> = {},
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.api = this.makeApi();
  }

  /** Evaluates the project and returns what it declares (or throws a ScriptError). */
  load(project: CompiledProject, raw: Record<string, unknown> = {}): ScriptDescription {
    for (const m of project.modules) {
      const bad = forbiddenSyntax(m.code);
      if (bad) throw { message: bad, kind: 'load', file: m.name } satisfies ScriptError;
      let factory: Factory;
      try {
        factory = new RealFunction(
          ...SHADOWED_GLOBALS,
          ...API_NAMES,
          'exports',
          'require',
          `return (function(){"use strict";\n${m.code}\n})\n//# sourceURL=htstrat/${safeFile(m.name)}`,
        ) as Factory;
      } catch (e) {
        throw locateError(e, 'compile');
      }
      this.modules.set(m.name, { factory, exports: {}, state: 'new' });
    }
    let entry: Record<string, unknown>;
    try {
      entry = this.require(project.entry);
    } catch (e) {
      throw locateError(e, 'load');
    }
    const meta = (entry.meta && typeof entry.meta === 'object' ? entry.meta : {}) as Record<
      string,
      unknown
    >;
    const params: Record<string, ParamDecl> = {};
    const pobj =
      entry.params && typeof entry.params === 'object'
        ? (entry.params as Record<string, unknown>)
        : null;
    if (pobj)
      for (const [k, v] of Object.entries(pobj)) {
        const d = asDecl(v);
        if (d) params[k] = d;
      }
    // Replace the declarations with values in place: hooks read `params.fast` as a number.
    if (pobj) Object.assign(pobj, resolveParams(params, raw));
    const hooks: HookName[] = [];
    for (const h of HOOKS)
      if (typeof entry[h] === 'function') {
        hooks.push(h);
        this.hooks[h] = entry[h] as (arg?: unknown) => void;
      }
    if (!this.hooks.onBar && !this.hooks.onTick)
      throw {
        message: 'A strategy must export onBar(bar) or onTick(tick)',
        kind: 'load',
        file: project.entry,
      } satisfies ScriptError;
    const tf =
      typeof meta.timeframe === 'string' && parseTimeframe(meta.timeframe) ? meta.timeframe : '5m';
    const tfs = Array.isArray(meta.timeframes)
      ? meta.timeframes
          .filter((x): x is string => typeof x === 'string' && !!parseTimeframe(x))
          .slice(0, 4)
      : [];
    this.description = {
      name: typeof meta.name === 'string' ? meta.name.slice(0, 80) : 'Untitled strategy',
      description: typeof meta.description === 'string' ? meta.description.slice(0, 500) : '',
      timeframe: tf,
      timeframes: [...new Set(tfs.filter((x) => x !== tf))],
      params,
      hooks,
    };
    return this.description;
  }

  /** Runs one host event through the matching hook. Never throws. */
  call(event: HostEvent): CallResult {
    this.frame = {
      snapshot: event.snapshot,
      index: -1,
      intents: [],
      logs: [],
      plots: [],
      dropped: 0,
    };
    this.append(event.bars);
    const primary = this.series.get('')?.bars.length ?? 0;
    this.frame.index = event.kind === 'bar' ? Math.min(event.index, primary - 1) : primary - 1;
    const t0 = now();
    let error: ScriptError | undefined;
    if (!this.stopped) {
      try {
        switch (event.kind) {
          case 'start':
            this.hooks.onStart?.();
            break;
          case 'bar':
            if (this.frame.index >= 0)
              this.hooks.onBar?.(this.series.get('')!.views[this.frame.index]);
            break;
          case 'tick':
            this.hooks.onTick?.({
              time: event.trade.ts,
              price: this.px(event.trade.px),
              qty: event.trade.qty,
              side: event.trade.side,
            });
            break;
          case 'order':
            this.hooks.onOrderUpdate?.({ ...event.order });
            break;
          case 'stop':
            this.stopped = true;
            this.hooks.onStop?.();
            break;
        }
      } catch (e) {
        error = locateError(e, 'runtime');
      }
    }
    const ms = now() - t0;
    const budget = event.kind === 'start' ? this.limits.budgetMs * 10 : this.limits.budgetMs;
    if (!error && ms > budget)
      error = {
        message: `CPU budget exceeded: ${event.kind} callback took ${ms.toFixed(0)} ms (limit ${budget} ms)`,
        kind: 'budget',
      };
    if (this.frame.dropped)
      this.frame.logs.push({
        ts: event.snapshot.time,
        level: 'warn',
        text: `${this.frame.dropped} orders / logs / plots over the per-callback limit were dropped`,
      });
    return {
      intents: this.frame.intents,
      logs: this.frame.logs,
      plots: this.frame.plots,
      error,
      ms,
    };
  }

  // ------------------------------------------------------------------ modules

  private require(name: string): Record<string, unknown> {
    if (name === 'ht' || name === '@htflow/strategy-api') return this.api;
    const key = this.resolve(name);
    const rec = key ? this.modules.get(key) : undefined;
    if (!rec)
      throw new Error(
        `Cannot import '${name}': only the strategy's own files and 'ht' are available`,
      );
    if (rec.state !== 'new') return rec.exports;
    rec.state = 'loading';
    const shadow = SHADOWED_GLOBALS.map(() => undefined);
    const api = API_NAMES.map((n) => this.api[n]);
    const body = rec.factory(...shadow, ...api, rec.exports, (n: string) =>
      this.require(String(n)),
    );
    body();
    rec.state = 'done';
    return rec.exports;
  }

  private resolve(name: string): string | undefined {
    const base = name.replace(/^\.\//, '');
    for (const c of [base, `${base}.ts`, `${base}.js`]) if (this.modules.has(c)) return c;
    return undefined;
  }

  // ------------------------------------------------------------------ data mirror

  private append(add: Record<string, Bar[]> | undefined): void {
    if (!add) return;
    for (const [tf, list] of Object.entries(add)) {
      if (!Array.isArray(list) || !list.length) continue;
      let s = this.series.get(tf);
      if (!s) this.series.set(tf, (s = { bars: [], version: 0, views: [] }));
      for (const b of list) {
        s.bars.push(b);
        s.views.push(this.view(b, s.bars.length - 1));
      }
      const n = s.bars.length;
      // Memory guard: bounded history; old bars lose their footprint.
      for (
        let i = Math.max(0, n - list.length - this.limits.footprintBars);
        i < n - this.limits.footprintBars;
        i++
      )
        if (s.bars[i]!.clusters?.size) s.bars[i]!.clusters = new Map();
      if (n > this.limits.maxBars) {
        const cut = n - this.limits.maxBars;
        s.bars.splice(0, cut);
        s.views.splice(0, cut);
        s.views.forEach((v, i) => (v.index = i));
      }
      s.version++;
    }
  }

  private view(b: Bar, index: number): BarView {
    return Object.freeze({
      time: b.t,
      open: this.px(b.o),
      high: this.px(b.h),
      low: this.px(b.l),
      close: this.px(b.c),
      volume: b.vol,
      buyVolume: b.buy,
      sellVolume: b.sell,
      delta: b.delta,
      trades: b.trades,
      index,
    }) as BarView;
  }

  private px(ticks: number): number {
    const p = this.instrument.pricePrecision;
    return Number((ticks * this.instrument.tickSize).toFixed(Math.min(12, Math.max(0, p))));
  }

  private seriesOf(tf: unknown): Series | undefined {
    const key =
      tf === undefined || tf === '' || tf === this.description?.timeframe ? '' : String(tf);
    return this.series.get(key);
  }

  /** Visible bars of a series (the primary series hides bars after the current event). */
  private visible(tf: unknown): { s: Series | undefined; end: number } {
    const s = this.seriesOf(tf);
    if (!s) return { s, end: 0 };
    const primary = s === this.series.get('');
    return { s, end: primary ? this.frame.index + 1 : s.bars.length };
  }

  private rawBar(barsAgo: unknown, tf: unknown): Bar | undefined {
    const { s, end } = this.visible(tf);
    const k = typeof barsAgo === 'number' && barsAgo >= 0 ? Math.floor(barsAgo) : 0;
    return s?.bars[end - 1 - k];
  }

  // ------------------------------------------------------------------ API

  private push<T>(list: T[], item: T, max: number): boolean {
    if (list.length >= max) {
      this.frame.dropped++;
      return false;
    }
    list.push(item);
    return true;
  }

  private order(
    side: 'buy' | 'sell',
    type: 'market' | 'limit' | 'stop',
    qty: unknown,
    price: unknown,
    opts: unknown,
  ): string | null {
    if (!this.frame.snapshot.canTrade) return null;
    const o = (opts && typeof opts === 'object' ? opts : {}) as Record<string, unknown>;
    const bracket: BracketIntent = {};
    if (typeof o.stop === 'number') bracket.stop = o.stop;
    if (typeof o.target === 'number') bracket.target = [o.target];
    else if (Array.isArray(o.target))
      bracket.target = o.target.filter((x) => typeof x === 'number');
    if (typeof o.trail === 'number') bracket.trail = o.trail;
    const cid = `c${++this.cid}`;
    const ok = this.push(
      this.frame.intents,
      {
        op: 'order',
        cid,
        side,
        type,
        qty: Number(qty),
        ...(type !== 'market' ? { price: Number(price) } : {}),
        ...(Object.keys(bracket).length ? { bracket } : {}),
        ...(typeof o.label === 'string' ? { label: o.label.slice(0, 64) } : {}),
      },
      this.limits.maxIntentsPerCall,
    );
    return ok ? cid : null;
  }

  private logLine(level: LogEntry['level'], args: unknown[]): void {
    const text = args
      .map((a) => {
        if (typeof a === 'string') return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(' ')
      .slice(0, 500);
    this.push(
      this.frame.logs,
      { ts: this.frame.snapshot.time, level, text },
      this.limits.maxLogsPerCall,
    );
  }

  private makeApi(): Record<string, unknown> {
    const side = (s: unknown): 'buy' | 'sell' => (s === 'sell' || s === 'short' ? 'sell' : 'buy');
    const fp = (b: Bar | undefined) =>
      b
        ? [...(b.clusters ?? new Map()).entries()]
            .sort((x, y) => x[0] - y[0])
            .map(([px, c]) => ({
              price: this.px(px),
              bid: c.bid,
              ask: c.ask,
              volume: c.bid + c.ask,
              delta: c.ask - c.bid,
            }))
        : [];
    const api: Record<string, unknown> = {
      buy: (qty: unknown, opts?: unknown) => this.order('buy', 'market', qty, undefined, opts),
      sell: (qty: unknown, opts?: unknown) => this.order('sell', 'market', qty, undefined, opts),
      limit: (s: unknown, qty: unknown, price: unknown, opts?: unknown) =>
        this.order(side(s), 'limit', qty, price, opts),
      stop: (s: unknown, qty: unknown, price: unknown, opts?: unknown) =>
        this.order(side(s), 'stop', qty, price, opts),
      bracket: (s: unknown, qty: unknown, opts?: unknown) => {
        const o = (opts && typeof opts === 'object' ? opts : {}) as Record<string, unknown>;
        return typeof o.entry === 'number'
          ? this.order(side(s), 'limit', qty, o.entry, o)
          : this.order(side(s), 'market', qty, undefined, o);
      },
      close: (label?: unknown) => {
        if (!this.frame.snapshot.canTrade) return false;
        return this.push(
          this.frame.intents,
          { op: 'close', ...(typeof label === 'string' ? { label: label.slice(0, 64) } : {}) },
          this.limits.maxIntentsPerCall,
        );
      },
      cancel: (id: unknown) =>
        typeof id === 'string' &&
        this.push(this.frame.intents, { op: 'cancel', cid: id }, this.limits.maxIntentsPerCall),
      cancelAll: () =>
        this.push(this.frame.intents, { op: 'cancelAll' }, this.limits.maxIntentsPerCall),
      position: () => {
        const p = this.frame.snapshot.position;
        return {
          qty: p.qty,
          side: p.qty > 0 ? 'long' : p.qty < 0 ? 'short' : 'flat',
          avgPrice: p.qty ? this.px(p.avgPx) : 0,
          openPnl: r6(p.openPnl),
        };
      },
      account: () => ({ ...this.frame.snapshot.account }),
      orders: () => this.frame.snapshot.orders.map((o) => ({ ...o })),
      bars: (tf?: unknown, count?: unknown) => {
        const { s, end } = this.visible(tf);
        if (!s) {
          if (
            tf !== undefined &&
            tf !== '' &&
            this.description &&
            !this.description.timeframes.includes(String(tf))
          )
            this.logLine('warn', [`bars('${String(tf)}'): declare it in meta.timeframes`]);
          return [];
        }
        const n = typeof count === 'number' && count > 0 ? Math.floor(count) : end;
        return s.views.slice(Math.max(0, end - n), end);
      },
      closes: (tf?: unknown, count?: unknown) =>
        (api.bars as (a?: unknown, b?: unknown) => BarView[])(tf, count).map((b) => b.close),
      footprint: (barsAgo?: unknown, tf?: unknown) => fp(this.rawBar(barsAgo, tf)),
      delta: (barsAgo?: unknown, tf?: unknown) => this.rawBar(barsAgo, tf)?.delta ?? 0,
      cvd: (tf?: unknown) => {
        const { s, end } = this.visible(tf);
        let c = 0;
        for (let i = 0; s && i < end; i++) c += s.bars[i]!.delta;
        return c;
      },
      poc: (barsAgo?: unknown, tf?: unknown) => {
        const b = this.rawBar(barsAgo, tf);
        return b ? this.px(pocOf(b)) : Number.NaN;
      },
      imbalances: (barsAgo?: unknown, opts?: unknown, tf?: unknown) => {
        const b = this.rawBar(barsAgo, tf);
        if (!b) return [];
        return imbalancesOf(b, (opts ?? {}) as { ratio?: number; minVolume?: number }).map((i) => ({
          price: this.px(i.px),
          side: i.side,
          ratio: i.ratio,
        }));
      },
      stackedImbalances: (barsAgo?: unknown, opts?: unknown, tf?: unknown) => {
        const b = this.rawBar(barsAgo, tf);
        if (!b) return { count: 0, side: null, from: Number.NaN, to: Number.NaN };
        const s = stackedOf(b, (opts ?? {}) as { ratio?: number; minVolume?: number });
        return { count: s.count, side: s.side, from: this.px(s.from), to: this.px(s.to) };
      },
      book: () => {
        const b = this.frame.snapshot.book;
        if (!b) return null;
        const conv = (l: [number, number][]) => l.map(([p, q]) => ({ price: this.px(p), size: q }));
        return { bids: conv(b.bids), asks: conv(b.asks) };
      },
      indicator: (id: unknown, inputs?: unknown, opts?: unknown) =>
        this.indicator(String(id), inputs as RawInputs | undefined, opts),
      ta,
      param,
      log: (...a: unknown[]) => this.logLine('info', a),
      warn: (...a: unknown[]) => this.logLine('warn', a),
      plot: (name: unknown, value: unknown, opts?: unknown) => {
        const o = (opts && typeof opts === 'object' ? opts : {}) as Record<string, unknown>;
        const v = Number(value);
        const bar = this.rawBar(0, '');
        if (!Number.isFinite(v) || !bar) return;
        this.push(
          this.frame.plots,
          {
            name: String(name).slice(0, 40),
            t: bar.t,
            value: v,
            ...(typeof o.color === 'string' ? { color: o.color.slice(0, 16) } : {}),
            overlay: o.overlay !== false,
          },
          this.limits.maxPlotsPerCall,
        );
      },
      time: () => this.frame.snapshot.time,
      last: () => this.px(this.frame.snapshot.last),
      canTrade: () => this.frame.snapshot.canTrade,
      instrument: Object.freeze({ ...this.instrument }),
    };
    return Object.freeze(api);
  }

  private indicator(id: string, raw: RawInputs | undefined, opts: unknown) {
    const tf = (opts && typeof opts === 'object' ? (opts as { tf?: unknown }).tf : undefined) ?? '';
    const key = `${id}|${String(tf)}|${raw ? JSON.stringify(raw) : ''}`;
    let e = this.inds.get(key);
    if (!e) {
      const def = indicatorById(id);
      if (!def) throw new Error(`Unknown indicator '${id}'`);
      const scale = new Set<string>();
      for (const [k, o] of Object.entries(def.outputs))
        if (o.unit === 'price' || (o.unit === undefined && def.pane === 'overlay')) scale.add(k);
      e = { rt: new IndicatorRuntime(def, raw), tf: String(tf), scale };
      this.inds.set(key, e);
    }
    const entry = e;
    const first = Object.keys(entry.rt.outputs)[0] ?? '';
    const sync = () => {
      const s = this.seriesOf(entry.tf);
      if (!s) return 0;
      const data: BarData = {
        bars: s.bars,
        version: s.version,
        tickSize: this.instrument.tickSize,
      };
      entry.rt.update(data);
      return this.visible(entry.tf).end;
    };
    const read = (output: string, index: number) => {
      const v = entry.rt.valueAt(output, index);
      return entry.scale.has(output) && Number.isFinite(v) ? r6(v * this.instrument.tickSize) : v;
    };
    return Object.freeze({
      value: (output?: unknown, barsAgo?: unknown) => {
        const end = sync();
        const k = typeof barsAgo === 'number' && barsAgo >= 0 ? Math.floor(barsAgo) : 0;
        return read(typeof output === 'string' ? output : first, end - 1 - k);
      },
      values: (output?: unknown, count?: unknown) => {
        const end = sync();
        const n = typeof count === 'number' && count > 0 ? Math.min(end, Math.floor(count)) : end;
        const out: number[] = [];
        for (let i = end - n; i < end; i++)
          out.push(read(typeof output === 'string' ? output : first, i));
        return out;
      },
    });
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
