import type { Bar, BarSpec, OrderBook, Trade } from '@htflow/market-data';
import { BarSeries } from '@htflow/market-data';
import {
  RiskEngine,
  defaultRiskRules,
  type Fill,
  type Order,
  type PaperEngine,
  type RiskRules,
} from '@htflow/trading';
import { Backtest, type BacktestConfig, type BacktestData, type BacktestResult } from '../backtest';
import type { StrategyRunner } from '../runtime';
import type { AnyStrategy, StrategyContext, StrategyInstrument } from '../types';
import { SandboxCore } from './core';
import {
  DEFAULT_LIMITS,
  parseTimeframe,
  type BarAppend,
  type CallResult,
  type CompiledProject,
  type HostEvent,
  type HostSnapshot,
  type LogEntry,
  type PlotPoint,
  type SandboxLimits,
  type ScriptDescription,
  type ScriptError,
  type ScriptOrder,
} from './protocol';
import { DEFAULT_ORDER_LIMITS, validateIntent, type OrderLimits } from './validate';

type MaybePromise<T> = T | Promise<T>;

/** How the trusted host talks to a sandbox (Web Worker, or in-process for tests / the VPS). */
export interface ScriptTransport {
  /** true: load / call return plain values (in-process core). */
  readonly sync: boolean;
  load(
    project: CompiledProject,
    params: Record<string, unknown>,
    instrument: StrategyInstrument,
    limits: SandboxLimits,
  ): MaybePromise<ScriptDescription>;
  call(event: HostEvent): MaybePromise<CallResult>;
  dispose(): void;
}

/**
 * In-process sandbox: the same `SandboxCore` the worker runs, called synchronously. Events are
 * structured-cloned so user code never holds the host's objects. Used by unit tests and the VPS
 * runner (where the whole process is dedicated to one strategy); the app uses the worker.
 */
export class InProcessTransport implements ScriptTransport {
  readonly sync = true;
  private core: SandboxCore | null = null;

  load(
    project: CompiledProject,
    params: Record<string, unknown>,
    instrument: StrategyInstrument,
    limits: SandboxLimits,
  ): ScriptDescription {
    this.core = new SandboxCore(
      {
        symbol: instrument.symbol,
        tickSize: instrument.tickSize,
        tickValue: instrument.tickValue,
        pricePrecision: instrument.pricePrecision,
      },
      limits,
    );
    return this.core.load(structuredClone(project), structuredClone(params));
  }

  call(event: HostEvent): CallResult {
    if (!this.core) throw new Error('Sandbox not loaded');
    return this.core.call(structuredClone(event));
  }

  dispose(): void {
    this.core = null;
  }
}

type Queued =
  | { kind: 'start' }
  | { kind: 'stop' }
  | { kind: 'bar'; index: number }
  | { kind: 'tick'; trade: Trade }
  | { kind: 'fill'; orderId: string; fill: Fill }
  | { kind: 'order'; order: ScriptOrder };

export interface AccountInfo {
  balance: number;
  equity: number;
  dayPnl: number;
  currency: string;
}

export interface BridgeOptions {
  instrument: StrategyInstrument;
  limits?: OrderLimits;
  account(): AccountInfo;
  onLog?(l: LogEntry): void;
  onPlot?(p: PlotPoint): void;
  onError?(e: ScriptError): void;
  /** Max logs kept in `bridge.logs`. */
  maxLogs?: number;
}

const MAX_CHAIN = 64;

/**
 * Trusted side of the HT Strategy API. Turns runner hooks into sandbox events, sends them with
 * the bars appended since the last event, and applies the answers: every intent is validated
 * (`validateIntent`) and placed through the runner's context, i.e. through the order engine and
 * its pre-trade checks (RiskEngine, slippage guard). Works with sync and async transports.
 */
export class ScriptBridge {
  readonly logs: LogEntry[] = [];
  readonly plots: PlotPoint[] = [];
  failed: ScriptError | null = null;
  /** While true (live warm-up) hooks only build bars: no events are sent. */
  silent = false;
  /** Calls made and the slowest one (ms). */
  readonly stats = { calls: 0, maxMs: 0, totalMs: 0 };
  private queue: Queued[] = [];
  private flushing: Promise<void> | null = null;
  private syncBusy = false;
  private runner: StrategyRunner | null = null;
  private extra = new Map<string, BarSeries>();
  private sent = new Map<string, number>();
  private cidToId = new Map<string, string>();
  private idToCid = new Map<string, string>();
  private labels = new Map<string, string>();
  private stopped = false;
  readonly limits: OrderLimits;
  readonly spec: BarSpec;

  constructor(
    readonly desc: ScriptDescription,
    readonly transport: ScriptTransport,
    readonly opts: BridgeOptions,
  ) {
    this.limits = opts.limits ?? DEFAULT_ORDER_LIMITS;
    this.spec = parseTimeframe(desc.timeframe) ?? { kind: 'time', ms: 300_000 };
    for (const tf of desc.timeframes) {
      const spec = parseTimeframe(tf);
      if (spec) this.extra.set(tf, new BarSeries(spec));
    }
  }

  /** The AnyStrategy a StrategyRunner / Backtest drives. */
  strategy(): AnyStrategy {
    return {
      id: `script:${this.desc.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name: this.desc.name,
      category: 'custom',
      description: this.desc.description,
      bars: this.spec,
      inputs: {},
      onBar: (ctx) => {
        if (this.silent || !this.desc.hooks.includes('onBar')) return;
        this.queue.push({ kind: 'bar', index: ctx.index });
      },
      onTrade: (_ctx, t) => {
        for (const s of this.extra.values()) s.add(t);
        if (this.silent) return;
        if (this.desc.hooks.includes('onTick')) this.queue.push({ kind: 'tick', trade: t });
        this.kick();
      },
      onFill: (_ctx, f) => {
        if (this.silent || !this.desc.hooks.includes('onOrderUpdate')) return;
        this.queue.push({ kind: 'fill', orderId: f.orderId, fill: f });
      },
    };
  }

  attach(runner: StrategyRunner): void {
    this.runner = runner;
  }

  pending(): boolean {
    return this.queue.length > 0 && !this.failed && !this.stopped;
  }

  start(): MaybePromise<void> {
    this.queue.push({ kind: 'start' });
    return this.drain();
  }

  /** Sends onStop (logs only; orders are ignored once stopping). */
  stop(): MaybePromise<void> {
    if (this.stopped) return;
    this.queue = this.failed ? [] : [{ kind: 'stop' }];
    const r = this.drain();
    const done = () => {
      this.stopped = true;
    };
    if (r instanceof Promise) return r.then(done);
    done();
  }

  /** Processes queued events (async transports); resolves when the queue is empty. */
  drain(): MaybePromise<void> {
    if (this.transport.sync) {
      this.drainSync();
      return;
    }
    this.flushing ??= this.drainAsync().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private kick(): void {
    if (this.transport.sync) this.drainSync();
  }

  private drainSync(): void {
    if (this.syncBusy) return;
    this.syncBusy = true;
    try {
      let n = 0;
      while (this.queue.length && !this.failed && n++ < MAX_CHAIN * 100) {
        const q = this.queue.shift()!;
        const ev = this.event(q);
        if (!ev) continue;
        this.apply(q, this.transport.call(ev) as CallResult);
      }
    } finally {
      this.syncBusy = false;
    }
  }

  private async drainAsync(): Promise<void> {
    while (this.queue.length && !this.failed) {
      const q = this.queue.shift()!;
      const ev = this.event(q);
      if (!ev) continue;
      let res: CallResult;
      try {
        res = await this.transport.call(ev);
      } catch (e) {
        this.fail(
          e && typeof e === 'object' && 'kind' in e
            ? (e as ScriptError)
            : { message: e instanceof Error ? e.message : String(e), kind: 'protocol' },
        );
        return;
      }
      this.apply(q, res);
    }
  }

  private fail(e: ScriptError): void {
    if (this.failed) return;
    this.failed = e;
    this.queue = [];
    this.log({ ts: this.ctx()?.time ?? 0, level: 'error', text: e.message });
    this.opts.onError?.(e);
  }

  private log(l: LogEntry): void {
    this.logs.push(l);
    const max = this.opts.maxLogs ?? 2000;
    if (this.logs.length > max) this.logs.splice(0, this.logs.length - max);
    this.opts.onLog?.(l);
  }

  private ctx(): StrategyContext | null {
    return this.runner?.context ?? null;
  }

  // ---------------------------------------------------------------- events

  private appendBars(): BarAppend {
    const out: BarAppend = {};
    const add = (key: string, bars: readonly Bar[]) => {
      const n = bars.length;
      const closed = n && bars[n - 1]!.closed ? n : n - 1;
      const from = this.sent.get(key) ?? 0;
      if (closed > from) {
        out[key] = bars.slice(from, closed) as Bar[];
        this.sent.set(key, closed);
      }
    };
    if (this.runner) add('', this.runner.series.bars);
    for (const [tf, s] of this.extra) add(tf, s.bars);
    return out;
  }

  private snapshot(): HostSnapshot {
    const ctx = this.ctx();
    const p = ctx?.position ?? { qty: 0, avgPx: 0, openPnl: 0 };
    return {
      time: ctx && Number.isFinite(ctx.time) ? ctx.time : 0,
      last: ctx?.last ?? Number.NaN,
      canTrade: !!ctx?.canTrade && !this.failed && !this.stopped,
      position: { qty: p.qty, avgPx: p.avgPx, openPnl: p.openPnl },
      account: this.opts.account(),
      orders: ctx ? ctx.workingOrders().map((o) => this.scriptOrder(o as Order)) : [],
      book: ctx?.book ? topOfBook(ctx.book) : null,
    };
  }

  private event(q: Queued): HostEvent | null {
    const snapshot = this.snapshot();
    if (q.kind === 'stop') snapshot.canTrade = false;
    const bars = this.appendBars();
    switch (q.kind) {
      case 'start':
        return { kind: 'start', snapshot, bars };
      case 'stop':
        return { kind: 'stop', snapshot, bars };
      case 'bar':
        return { kind: 'bar', index: q.index, snapshot, bars };
      case 'tick':
        return {
          kind: 'tick',
          trade: {
            ts: q.trade.ts,
            px: q.trade.px,
            qty: q.trade.qty,
            side: q.trade.side === 'sell' ? 'sell' : 'buy',
          },
          snapshot,
          bars,
        };
      case 'order':
        return { kind: 'order', order: q.order, snapshot, bars };
      case 'fill': {
        const o = this.runner?.host.engine.orders.get(q.orderId);
        if (!o) return null;
        const order = this.scriptOrder(o);
        order.fillPrice = this.price(q.fill.px);
        order.fillQty = q.fill.qty;
        return { kind: 'order', order, snapshot, bars };
      }
    }
  }

  private price(ticks: number): number {
    const i = this.opts.instrument;
    return Number((ticks * i.tickSize).toFixed(Math.min(12, Math.max(0, i.pricePrecision))));
  }

  private scriptOrder(o: Order): ScriptOrder {
    const id = this.idToCid.get(o.id) ?? `#${o.id}`;
    const parent = o.parentId ? (this.idToCid.get(o.parentId) ?? `#${o.parentId}`) : undefined;
    const px = o.px ?? o.stopPx;
    return {
      id,
      ...(parent ? { parent } : {}),
      ...(o.role ? { role: o.role } : {}),
      side: o.side,
      type: o.type,
      qty: o.qty,
      filled: o.filled,
      status: o.status,
      ...(px !== undefined ? { price: this.price(px) } : {}),
      ...(o.filled ? { avgFillPrice: this.price(o.avgFillPx) } : {}),
      ...(o.reason ? { reason: o.reason } : {}),
      ...(this.labels.has(id) ? { label: this.labels.get(id) } : {}),
    };
  }

  // ---------------------------------------------------------------- results

  private apply(q: Queued, res: CallResult): void {
    this.stats.calls++;
    this.stats.totalMs += res.ms;
    this.stats.maxMs = Math.max(this.stats.maxMs, res.ms);
    for (const l of (Array.isArray(res.logs) ? res.logs : []).slice(0, 200))
      this.log({
        ts: Number(l.ts) || 0,
        level: l.level === 'warn' || l.level === 'error' ? l.level : 'info',
        text: String(l.text).slice(0, 500),
      });
    for (const p of (Array.isArray(res.plots) ? res.plots : []).slice(0, 64)) {
      if (!Number.isFinite(p.value) || !Number.isFinite(p.t)) continue;
      const pt: PlotPoint = {
        name: String(p.name).slice(0, 40),
        t: p.t,
        value: p.value,
        overlay: p.overlay !== false,
        ...(typeof p.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(p.color)
          ? { color: p.color }
          : {}),
      };
      this.plots.push(pt);
      this.opts.onPlot?.(pt);
    }
    if (this.plots.length > 200_000) this.plots.splice(0, this.plots.length - 200_000);
    if (res.error) {
      this.fail(res.error);
      return;
    }
    if (q.kind === 'stop' || this.stopped) return;
    const ctx = this.ctx();
    if (!ctx) return;
    let pending = 0;
    for (const raw of (Array.isArray(res.intents) ? res.intents : []).slice(0, 50)) {
      const v = validateIntent(raw, this.opts.instrument, this.limits, {
        last: ctx.last,
        position: ctx.position.qty,
        pending,
      });
      if (!v.ok) {
        this.reject(raw, v.reason);
        continue;
      }
      const it = v.intent;
      switch (it.op) {
        case 'cancel': {
          const id = it.cid.startsWith('#') ? it.cid.slice(1) : this.cidToId.get(it.cid);
          if (id && ctx.cancel(id)) this.notifyOrder(id);
          break;
        }
        case 'cancelAll':
          ctx.cancelAll();
          break;
        case 'close':
          ctx.flatten(it.label ?? 'close');
          break;
        case 'order': {
          const opts = {
            ...(it.label ? { label: it.label } : {}),
            ...(it.bracket ? { bracket: it.bracket } : {}),
          };
          const buy = it.side === 'buy';
          const h =
            it.type === 'market'
              ? buy
                ? ctx.buy(it.qty, opts)
                : ctx.sell(it.qty, opts)
              : it.type === 'limit'
                ? buy
                  ? ctx.buyLimit(it.qty, it.px!, opts)
                  : ctx.sellLimit(it.qty, it.px!, opts)
                : buy
                  ? ctx.buyStop(it.qty, it.px!, opts)
                  : ctx.sellStop(it.qty, it.px!, opts);
          if (!h) {
            this.reject(raw, 'rejected by the order engine / risk engine (see log)');
            break;
          }
          this.cidToId.set(it.cid, h.id);
          this.idToCid.set(h.id, it.cid);
          if (it.label) this.labels.set(it.cid, it.label);
          if (h.status !== 'filled') pending += buy ? it.qty - h.filled : -(it.qty - h.filled);
          break;
        }
      }
    }
  }

  private notifyOrder(engineId: string): void {
    if (!this.desc.hooks.includes('onOrderUpdate')) return;
    const o = this.runner?.host.engine.orders.get(engineId);
    if (o) this.queue.push({ kind: 'order', order: this.scriptOrder(o) });
  }

  private reject(raw: unknown, reason: string): void {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    this.log({ ts: this.ctx()?.time ?? 0, level: 'warn', text: `Order rejected: ${reason}` });
    if (r.op !== 'order' || typeof r.cid !== 'string' || !this.desc.hooks.includes('onOrderUpdate'))
      return;
    this.queue.push({
      kind: 'order',
      order: {
        id: r.cid.slice(0, 12),
        side: r.side === 'sell' ? 'sell' : 'buy',
        type: String(r.type).slice(0, 10),
        qty: Number(r.qty) || 0,
        filled: 0,
        status: 'rejected',
        reason,
      },
    });
  }
}

function topOfBook(b: OrderBook): HostSnapshot['book'] {
  const bids = [...b.bids.entries()].sort((x, y) => y[0] - x[0]).slice(0, 10);
  const asks = [...b.asks.entries()].sort((x, y) => x[0] - y[0]).slice(0, 10);
  return { bids, asks };
}

/** Maps strategy risk limits onto the existing RiskEngine rule set (backtests). */
export function scriptRiskRules(limits: OrderLimits, dailyLoss: number): RiskRules {
  const r = defaultRiskRules('UTC');
  r.maxPositionSize = { enabled: true, value: limits.maxPosition, perInstrument: {} };
  r.dailyLossLimit = { enabled: dailyLoss > 0, value: dailyLoss > 0 ? dailyLoss : 1 };
  return r;
}

export interface ScriptBacktestResult {
  result: BacktestResult;
  description: ScriptDescription;
  logs: LogEntry[];
  plots: PlotPoint[];
  error: ScriptError | null;
  calls: number;
  maxCallMs: number;
}

export interface ScriptBacktestOptions {
  params?: Record<string, unknown>;
  limits?: OrderLimits;
  sandbox?: SandboxLimits;
  /** Daily loss limit (account currency) enforced by the RiskEngine; 0 = off. */
  dailyLoss?: number;
  /** Bar spec override (default: the script's `meta.timeframe`). */
  bars?: BarSpec;
  signal?: AbortSignal;
  onProgress?(p: number): void;
}

/**
 * Backtests a compiled HT Editor script on history with the existing deterministic Backtest
 * (PaperEngine fills, costs, equity curve, stats). The backtest pauses after every trade that
 * produced events, so a worker sandbox answers before the next trade is replayed: results are the
 * same with the worker and the in-process transport.
 */
export async function runScriptBacktest(
  project: CompiledProject,
  transport: ScriptTransport,
  data: BacktestData,
  config: Omit<BacktestConfig, 'bars'> & { bars?: BarSpec },
  opts: ScriptBacktestOptions = {},
): Promise<ScriptBacktestResult> {
  const description = await transport.load(
    project,
    opts.params ?? {},
    config.instrument,
    opts.sandbox ?? DEFAULT_LIMITS,
  );
  let bt: Backtest | null = null;
  const limits = opts.limits ?? DEFAULT_ORDER_LIMITS;
  const bridge = new ScriptBridge(description, transport, {
    instrument: config.instrument,
    limits,
    account: () => accountOf(bt?.engine, 'backtest', config.instrument.id, bt?.runner.last),
  });
  bt = new Backtest(bridge.strategy(), {}, data, {
    ...config,
    bars: opts.bars ?? config.bars ?? bridge.spec,
  });
  bridge.attach(bt.runner);
  const b = bt;
  const risk = new RiskEngine(
    b.engine,
    { now: () => b.now, mark: () => b.runner.last },
    scriptRiskRules(limits, opts.dailyLoss ?? 0),
  );
  try {
    await bridge.start();
    let k = 0;
    for (;;) {
      const done = b.step(transport.sync ? 16 : 8, () => bridge.pending());
      if (bridge.pending()) await bridge.drain();
      if (done) break;
      if ((++k & 255) === 0 || transport.sync) {
        if (opts.signal?.aborted) throw new Error('Backtest cancelled');
        opts.onProgress?.(b.progress());
        if (transport.sync) await new Promise((r) => setTimeout(r, 0));
      }
    }
    await bridge.stop();
  } finally {
    risk.dispose();
  }
  opts.onProgress?.(1);
  return {
    result: b.result(),
    description,
    logs: bridge.logs,
    plots: bridge.plots,
    error: bridge.failed,
    calls: bridge.stats.calls,
    maxCallMs: bridge.stats.maxMs,
  };
}

/** Balance / equity of an engine account, for the snapshot sent to the sandbox. */
export function accountOf(
  engine: PaperEngine | undefined,
  accountId: string,
  instrumentId: string,
  mark: number | undefined,
): AccountInfo {
  const acc = engine?.accounts.get(accountId);
  if (!engine || !acc) return { balance: 0, equity: 0, dayPnl: 0, currency: 'USD' };
  const open =
    mark !== undefined && Number.isFinite(mark)
      ? engine.unrealized(accountId, instrumentId, mark)
      : 0;
  const equity = acc.balance + open;
  return {
    balance: acc.balance,
    equity,
    dayPnl: equity - acc.startingBalance,
    currency: acc.currency ?? 'USD',
  };
}
