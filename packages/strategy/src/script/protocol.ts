import type { Bar, BarSpec } from '@htflow/market-data';

/**
 * HT Strategy sandbox protocol (HT Editor). The trusted host (main thread: backtest, paper, live)
 * sends `HostEvent`s; the untrusted sandbox (a Web Worker running the user's code, or an
 * in-process core in tests / on the VPS) answers each with a `CallResult`. Nothing the sandbox
 * returns is trusted: every intent is re-validated (`validateIntent`) and then goes through the
 * risk engine before it reaches an order engine.
 */

export const SCRIPT_PROTOCOL = 1;

/** One compiled file of a strategy project (CommonJS-style body produced by the compiler). */
export interface CompiledModule {
  name: string;
  code: string;
}

export interface CompiledProject {
  /** File name of the entry module (the strategy). */
  entry: string;
  modules: CompiledModule[];
}

/** A `param.*` declaration as plain data (turned into an InputDef on the host). */
export type ParamDecl =
  | {
      type: 'int' | 'float';
      label: string;
      default: number;
      min?: number;
      max?: number;
      step?: number;
    }
  | { type: 'bool'; label: string; default: boolean }
  | { type: 'choice'; label: string; default: string; options: string[] }
  | { type: 'string'; label: string; default: string };

export type HookName = 'onStart' | 'onBar' | 'onTick' | 'onOrderUpdate' | 'onStop';
export const HOOKS: HookName[] = ['onStart', 'onBar', 'onTick', 'onOrderUpdate', 'onStop'];

/** What a loaded strategy declares. */
export interface ScriptDescription {
  name: string;
  description: string;
  /** Primary timeframe label ('5m', '500t', …). */
  timeframe: string;
  /** Extra timeframes the strategy reads with `bars(tf)` / `indicator(…, { tf })`. */
  timeframes: string[];
  params: Record<string, ParamDecl>;
  hooks: HookName[];
}

export interface ScriptError {
  message: string;
  /** 1-based line in `file` when known. */
  line?: number;
  column?: number;
  file?: string;
  kind: 'compile' | 'load' | 'runtime' | 'budget' | 'protocol';
}

/** Order state as the strategy sees it. Prices are in price units, not ticks. */
export interface ScriptOrder {
  /** Client id returned by buy / sell / limit / …, or `#<engine id>` for bracket children. */
  id: string;
  parent?: string;
  role?: 'entry' | 'sl' | 'tp';
  side: 'buy' | 'sell';
  type: string;
  qty: number;
  filled: number;
  status: string;
  price?: number;
  avgFillPrice?: number;
  fillPrice?: number;
  fillQty?: number;
  reason?: string;
  label?: string;
}

/** Host state sent with every event (prices in ticks; the sandbox converts). */
export interface HostSnapshot {
  time: number;
  /** Last trade price in ticks (NaN before the first trade). */
  last: number;
  canTrade: boolean;
  position: { qty: number; avgPx: number; openPnl: number };
  account: { balance: number; equity: number; dayPnl: number; currency: string };
  orders: ScriptOrder[];
  /** Top of the book in ticks, best first; null when no book. */
  book: { bids: [number, number][]; asks: [number, number][] } | null;
}

export interface InstrumentInfo {
  symbol: string;
  tickSize: number;
  tickValue: number;
  pricePrecision: number;
}

/** Bars appended since the previous event, per timeframe label ('' = primary). */
export type BarAppend = Record<string, Bar[]>;

export type HostEvent =
  | { kind: 'start'; snapshot: HostSnapshot; bars: BarAppend }
  | { kind: 'bar'; index: number; snapshot: HostSnapshot; bars: BarAppend }
  | {
      kind: 'tick';
      trade: { ts: number; px: number; qty: number; side: 'buy' | 'sell' };
      snapshot: HostSnapshot;
      bars: BarAppend;
    }
  | { kind: 'order'; order: ScriptOrder; snapshot: HostSnapshot; bars: BarAppend }
  | { kind: 'stop'; snapshot: HostSnapshot; bars: BarAppend };

export interface BracketIntent {
  /** Stop distance in ticks. */
  stop?: number;
  /** Target distance(s) in ticks. */
  target?: number[];
  /** Trailing stop distance in ticks. */
  trail?: number;
}

/** What the sandbox asks for. Untrusted: validated field by field on the host. */
export type ScriptIntent =
  | {
      op: 'order';
      cid: string;
      side: 'buy' | 'sell';
      type: 'market' | 'limit' | 'stop';
      qty: number;
      /** Limit / stop price in price units. */
      price?: number;
      bracket?: BracketIntent;
      label?: string;
    }
  | { op: 'cancel'; cid: string }
  | { op: 'cancelAll' }
  | { op: 'close'; label?: string };

export interface LogEntry {
  ts: number;
  level: 'info' | 'warn' | 'error';
  text: string;
}

export interface PlotPoint {
  name: string;
  /** Bar open time of the plotted value. */
  t: number;
  value: number;
  color?: string;
  /** true = drawn on the price chart, false = own pane. */
  overlay: boolean;
}

export interface CallResult {
  intents: ScriptIntent[];
  logs: LogEntry[];
  plots: PlotPoint[];
  error?: ScriptError;
  /** CPU time spent in the user's callback, ms. */
  ms: number;
}

/** Guards applied inside the sandbox (bounded buffers) and on the host (time budget). */
export interface SandboxLimits {
  /** Per-callback CPU budget, ms (onStart gets 10×). */
  budgetMs: number;
  maxIntentsPerCall: number;
  maxLogsPerCall: number;
  maxPlotsPerCall: number;
  /** Bars kept per timeframe in the sandbox mirror. */
  maxBars: number;
  /** Bars that keep their footprint (older bars drop clusters). */
  footprintBars: number;
}

export const DEFAULT_LIMITS: SandboxLimits = {
  budgetMs: 250,
  maxIntentsPerCall: 20,
  maxLogsPerCall: 50,
  maxPlotsPerCall: 32,
  maxBars: 20_000,
  footprintBars: 500,
};

/** Worker message envelope. */
export type SandboxRequest =
  | {
      seq: number;
      type: 'load';
      project: CompiledProject;
      params: Record<string, unknown>;
      instrument: InstrumentInfo;
      limits: SandboxLimits;
    }
  | { seq: number; type: 'call'; event: HostEvent };

export type SandboxResponse =
  | { seq: number; type: 'loaded'; description?: ScriptDescription; error?: ScriptError }
  | { seq: number; type: 'result'; result: CallResult };

/** Parses '5m', '1h', '30s', '500t' (ticks), '1000v' (volume), '8r' (range). */
export function parseTimeframe(tf: string): BarSpec | null {
  const m = /^(\d+)(s|m|h|d|t|v|r)$/.exec(tf.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!(n > 0) || n > 1e7) return null;
  switch (m[2]) {
    case 's':
      return { kind: 'time', ms: n * 1000 };
    case 'm':
      return { kind: 'time', ms: n * 60_000 };
    case 'h':
      return { kind: 'time', ms: n * 3_600_000 };
    case 'd':
      return { kind: 'time', ms: n * 86_400_000 };
    case 't':
      return { kind: 'tick', n };
    case 'v':
      return { kind: 'volume', n };
    default:
      return { kind: 'range', ticks: n };
  }
}
