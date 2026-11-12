import {
  IndicatorRuntime,
  resolveInputs,
  type AnyIndicator,
  type BarData,
  type InputDefs,
  type InputValues,
  type RawInputs,
} from '@htflow/indicator-sdk';
import { indicatorById } from '@htflow/indicators';
import {
  BarSeries,
  type Bar,
  type BarSpec,
  type OrderBook,
  type Side,
  type Trade,
} from '@htflow/market-data';
import {
  atrTicks,
  pnlPerTick,
  resolveAtm,
  type AtmTemplate,
  type BracketSpec,
  type Fill,
  type Order,
  type OrderType,
  type PaperEngine,
  type PostFillHook,
} from '@htflow/trading';
import { imbalancesOf, pocOf, stackedOf } from './footprint';
import type {
  AnyStrategy,
  BracketOpts,
  IndicatorHandle,
  OrderHandle,
  OrderOpts,
  StrategyContext,
  StrategyInstrument,
  StrategyLog,
  StrategyPosition,
} from './types';

/** Where a runner trades and how it reports. */
export interface RunnerHost {
  engine: PaperEngine;
  accountId: string;
  instrument: StrategyInstrument;
  bars: BarSpec;
  /** Journal / order tag of every order (default `strategy:<id>`). */
  tag?: string;
  /** Trading window (epoch ms). Outside it orders are ignored; at its end the runner flattens. */
  window?: { from: number; to: number };
  /** Trades between two times (tape-based indicators, e.g. Big Trades). */
  tradesBetween?(from: number, to: number): readonly Trade[];
  /** ATM templates by id (`opts.atm`); resolved at the current price with the bars' ATR. */
  atm?(id: string): AtmTemplate | undefined;
  /** ATM template applied to every bracketed entry instead of the strategy's own bracket. */
  atmOverride?: string;
  onLog?(log: StrategyLog): void;
  /** Called after every closed bar (equity sampling). */
  onBarClosed?(index: number, bar: Bar): void;
  /** Called for every fill of this runner's orders. */
  onFill?(fill: Fill): void;
  /** Max lines kept in `runner.logs` (default 500). */
  maxLogs?: number;
}

interface IndEntry {
  rt: IndicatorRuntime;
  def: AnyIndicator;
  version: number;
}

const NaN_ = Number.NaN;

/** Normalises a bracket into the paper engine's spec (targets as an array). */
export function toBracketSpec(b: BracketOpts | undefined): BracketSpec | undefined {
  if (!b) return undefined;
  const tp =
    b.targetTicks === undefined
      ? undefined
      : (Array.isArray(b.targetTicks) ? b.targetTicks : [b.targetTicks]).filter((x) => x > 0);
  const sl = b.stopTicks && b.stopTicks > 0 ? b.stopTicks : undefined;
  const trail = b.trailTicks && b.trailTicks > 0 ? b.trailTicks : undefined;
  if (!sl && !trail && !tp?.length) return undefined;
  return {
    slTicks: sl,
    ...(trail ? { slTrail: { kind: 'ticks' as const, amount: trail } } : {}),
    tpTicks: tp?.length ? tp : undefined,
  };
}

/**
 * Runs one strategy on a stream of trades: builds bars, keeps indicators up to date, calls the
 * hooks and routes orders to a PaperEngine (its own in backtests, the app's paper engine live).
 * The caller feeds trades to the engine first (`engine.onTrade`) so resting orders fill before
 * the strategy sees the trade.
 */
export class StrategyRunner {
  readonly series: BarSeries;
  readonly inputs: InputValues<InputDefs>;
  readonly tag: string;
  readonly logs: StrategyLog[] = [];
  /** Labels given to orders (`opts.label`), by order id. */
  readonly labels = new Map<string, string>();
  /** Initial stop price per entry order id (for R multiples). */
  readonly initialStops = new Map<string, number>();
  /** Order roles at fill time ('sl' / 'tp' / 'entry'), by order id. */
  readonly roles = new Map<string, NonNullable<Order['role']>>();
  /** When true no orders are sent (history warm-up of live runs). */
  warmup = false;
  time = NaN_;
  last = NaN_;
  private state: unknown;
  private notified = 0;
  private cur = 0;
  private cvdPrefix: number[] = [];
  private inds = new Map<string, IndEntry>();
  private book: OrderBook | null = null;
  private ctx: StrategyContext<InputDefs, unknown>;
  private windowClosed = false;
  private hook: PostFillHook;
  private disposed = false;

  constructor(
    readonly def: AnyStrategy,
    raw: RawInputs | undefined,
    readonly host: RunnerHost,
  ) {
    this.inputs = resolveInputs(def.inputs, raw);
    this.tag = host.tag ?? `strategy:${def.id}`;
    this.series = new BarSeries(host.bars);
    this.state = def.init?.(this.inputs);
    this.ctx = this.makeContext();
    this.hook = (fill) => this.onEngineFill(fill);
    host.engine.postFillHooks.push(this.hook);
  }

  /** Removes the fill hook from the engine (live runners). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const hooks = this.host.engine.postFillHooks;
    const i = hooks.indexOf(this.hook);
    if (i >= 0) hooks.splice(i, 1);
  }

  get canTrade(): boolean {
    if (this.warmup || this.disposed) return false;
    const w = this.host.window;
    return !w || (this.time >= w.from && this.time < w.to);
  }

  /** Feeds one trade (in time order). */
  onTrade(t: Trade): void {
    this.time = t.ts;
    this.last = t.px;
    this.checkWindow();
    this.series.add(t);
    const bars = this.series.bars;
    const n = bars.length;
    const lastClosed = bars[n - 1]!.closed ? n - 1 : n - 2;
    while (this.notified <= lastClosed) this.closeBar(this.notified++);
    if (this.def.onTrade) {
      this.cur = n - 1;
      this.def.onTrade(this.ctx, t);
    }
  }

  /** Book changed (at most once per event time). */
  onBook(book: OrderBook, ts: number): void {
    this.book = book;
    if (ts > this.time || Number.isNaN(this.time)) this.time = ts;
    if (!this.def.onBook || !this.series.bars.length) return;
    this.cur = this.series.bars.length - 1;
    this.def.onBook(this.ctx, book);
  }

  setBook(book: OrderBook | null): void {
    this.book = book;
  }

  /** Signed position of this runner's account on the instrument. */
  position(): StrategyPosition {
    const { engine, accountId, instrument } = this.host;
    const p = engine.position(accountId, instrument.id);
    const openPnl =
      p.qty && !Number.isNaN(this.last) ? (this.last - p.avgPx) * pnlPerTick(instrument, p.qty) : 0;
    return {
      qty: p.qty,
      avgPx: p.avgPx,
      side: p.qty > 0 ? 'long' : p.qty < 0 ? 'short' : 'flat',
      openPnl,
    };
  }

  /** Cancels this runner's working orders and closes its position at market. */
  flatten(label = 'flatten', force = false): void {
    const { engine, accountId, instrument } = this.host;
    for (const o of engine.workingOrders(accountId, instrument.id))
      if (o.tag === this.tag) engine.cancel(o.id, true);
    const p = engine.position(accountId, instrument.id);
    if (p.qty === 0 || (!force && this.disposed)) return;
    const o = engine.place({
      accountId,
      instrumentId: instrument.id,
      side: p.qty > 0 ? 'sell' : 'buy',
      type: 'market',
      qty: Math.abs(p.qty),
      tag: this.tag,
    });
    this.labels.set(o.id, label);
  }

  log(text: string): void {
    const l = { ts: this.time, text };
    this.logs.push(l);
    const max = this.host.maxLogs ?? 500;
    if (this.logs.length > max) this.logs.splice(0, this.logs.length - max);
    this.host.onLog?.(l);
  }

  // ---------------------------------------------------------------- internals

  private checkWindow(): void {
    const w = this.host.window;
    if (!w || this.windowClosed || this.time < w.to) return;
    this.windowClosed = true;
    this.flatten('window end', true);
  }

  private closeBar(i: number): void {
    const bars = this.series.bars;
    const b = bars[i]!;
    this.cvdPrefix[i] = (i > 0 ? (this.cvdPrefix[i - 1] ?? 0) : 0) + b.delta;
    this.cur = i;
    this.def.onBar?.(this.ctx);
    this.host.onBarClosed?.(i, b);
  }

  private cvdAt(i: number): number {
    if (i < this.notified) return this.cvdPrefix[i] ?? 0;
    const b = this.series.bars[i];
    return (i > 0 ? (this.cvdPrefix[i - 1] ?? 0) : 0) + (b?.delta ?? 0);
  }

  private onEngineFill(fill: Fill): void {
    if (fill.tag !== this.tag) return;
    const { engine } = this.host;
    const o = engine.orders.get(fill.orderId);
    if (o?.role) this.roles.set(o.id, o.role);
    // Bracket children exist once the entry is fully filled: remember the initial stop.
    if (o?.status === 'filled' && o.role === 'entry' && !this.initialStops.has(o.id)) {
      for (const c of engine.orders.values())
        if (c.parentId === o.id && c.role === 'sl' && c.stopPx !== undefined) {
          this.initialStops.set(o.id, c.stopPx);
          this.roles.set(c.id, 'sl');
        }
      for (const c of engine.orders.values())
        if (c.parentId === o.id && c.role) this.roles.set(c.id, c.role);
    }
    this.host.onFill?.(fill);
    if (this.def.onFill) {
      this.cur = Math.max(0, this.series.bars.length - 1);
      this.def.onFill(this.ctx, fill);
    }
  }

  private place(
    side: Side,
    type: OrderType,
    qty: number,
    px: number | undefined,
    stopPx: number | undefined,
    opts: OrderOpts = {},
    trailTicks?: number,
  ): OrderHandle | null {
    if (!this.canTrade || !(qty > 0)) return null;
    const { engine, accountId, instrument } = this.host;
    let bracket = toBracketSpec(opts.bracket);
    const atmId = opts.atm ?? (opts.bracket ? this.host.atmOverride : undefined);
    const tpl = atmId ? this.host.atm?.(atmId) : undefined;
    if (tpl) {
      const refPx = px ?? stopPx ?? this.last;
      const spec = resolveAtm(tpl, {
        econ: instrument,
        refPx,
        atrTicks: atrTicks(this.series.bars, tpl.atrPeriod),
      });
      if (spec.slTicks || spec.slTrail || spec.tpTicks?.length) bracket = spec;
    }
    const o = engine.place({
      accountId,
      instrumentId: instrument.id,
      side,
      type,
      qty,
      px,
      stopPx,
      tag: this.tag,
      ...(trailTicks ? { trail: { kind: 'ticks' as const, amount: trailTicks } } : {}),
      bracket,
    });
    if (opts.label) this.labels.set(o.id, opts.label);
    if (o.status === 'rejected') {
      this.log(`Order rejected: ${o.reason ?? 'unknown reason'}`);
      return null;
    }
    // A market entry with a bracket filled synchronously: its children exist now.
    if (o.status === 'filled' && o.role === 'entry') this.captureBracket(o);
    return o;
  }

  private captureBracket(o: Order): void {
    for (const c of this.host.engine.orders.values()) {
      if (c.parentId !== o.id) continue;
      if (c.role) this.roles.set(c.id, c.role);
      if (c.role === 'sl' && c.stopPx !== undefined) {
        if (!this.initialStops.has(o.id)) this.initialStops.set(o.id, c.stopPx);
      }
    }
  }

  private indicator(id: string, raw?: RawInputs): IndicatorHandle {
    const key = `${id}|${raw ? JSON.stringify(raw) : ''}`;
    let e = this.inds.get(key);
    if (!e) {
      const def = indicatorById(id);
      if (!def) throw new Error(`Unknown indicator: ${id}`);
      e = { rt: new IndicatorRuntime(def, raw), def, version: -1 };
      this.inds.set(key, e);
    }
    const entry = e;
    const first = Object.keys(entry.def.outputs)[0] ?? '';
    const sync = () => {
      if (entry.version === this.series.version) return;
      const data: BarData = {
        bars: this.series.bars,
        version: this.series.version,
        tickSize: this.host.instrument.tickSize,
        tradesBetween: this.host.tradesBetween,
      };
      entry.rt.update(data);
      entry.version = this.series.version;
    };
    return {
      value: (output = first, barsAgo = 0) => {
        sync();
        return entry.rt.valueAt(output, this.cur - barsAgo);
      },
      at: (output, index) => {
        sync();
        return entry.rt.valueAt(output, index);
      },
    };
  }

  private makeContext(): StrategyContext<InputDefs, unknown> {
    // Getters on a plain object read the runner's live state.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const { instrument } = this.host;
    return {
      get inputs() {
        return self.inputs;
      },
      instrument,
      get bars() {
        return self.series.bars;
      },
      get bar() {
        return self.series.bars[self.cur]!;
      },
      get index() {
        return self.cur;
      },
      get time() {
        return self.time;
      },
      get last() {
        return self.last;
      },
      get cvd() {
        return self.cvdAt(self.cur);
      },
      get book() {
        return self.book;
      },
      get position() {
        return self.position();
      },
      get canTrade() {
        return self.canTrade;
      },
      get state() {
        return self.state;
      },
      indicator: (id, raw) => self.indicator(id, raw),
      poc: (bar) => pocOf(bar ?? self.series.bars[self.cur]!),
      imbalances: (bar, o) => imbalancesOf(bar ?? self.series.bars[self.cur]!, o),
      stackedImbalances: (bar, o) => stackedOf(bar ?? self.series.bars[self.cur]!, o),
      buy: (q, o) => self.place('buy', 'market', q, undefined, undefined, o),
      sell: (q, o) => self.place('sell', 'market', q, undefined, undefined, o),
      buyLimit: (q, px, o) => self.place('buy', 'limit', q, px, undefined, o),
      sellLimit: (q, px, o) => self.place('sell', 'limit', q, px, undefined, o),
      buyStop: (q, px, o) => self.place('buy', 'stop', q, undefined, px, o),
      sellStop: (q, px, o) => self.place('sell', 'stop', q, undefined, px, o),
      buyMit: (q, px, o) => self.place('buy', 'mit', q, undefined, px, o),
      sellMit: (q, px, o) => self.place('sell', 'mit', q, undefined, px, o),
      buyTrailingStop: (q, trail, o) =>
        self.place('buy', 'trailing-stop', q, undefined, undefined, o, trail),
      sellTrailingStop: (q, trail, o) =>
        self.place('sell', 'trailing-stop', q, undefined, undefined, o, trail),
      cancel: (id) => {
        const o = self.host.engine.orders.get(id);
        return !!o && o.tag === self.tag && self.host.engine.cancel(id);
      },
      cancelAll: () => {
        const { engine, accountId } = self.host;
        for (const o of engine.workingOrders(accountId, instrument.id))
          if (o.tag === self.tag) engine.cancel(o.id, true);
      },
      flatten: (label) => {
        if (self.canTrade) self.flatten(label ?? 'flatten');
      },
      workingOrders: () =>
        self.host.engine
          .workingOrders(self.host.accountId, instrument.id)
          .filter((o) => o.tag === self.tag),
      qtyForRisk: (stopTicks, money) => {
        const perContract = pnlPerTick(instrument, 1) * Math.max(1, stopTicks);
        return perContract > 0 ? Math.max(0, Math.floor(money / perContract)) : 0;
      },
      log: (m) => self.log(m),
    };
  }
}
