import type { RawInputs } from '@htflow/indicator-sdk';
import {
  OrderBook,
  type BarSpec,
  type BookSnapshot,
  type Level,
  type Trade,
} from '@htflow/market-data';
import type { ReplayDataset } from '@htflow/replay';
import {
  PaperEngine,
  excursion,
  journalStats,
  netOf,
  pnlPerTick,
  roundTrips,
  type AtmTemplate,
  type Fill,
  type RoundTrip,
} from '@htflow/trading';
import { monteCarloDrawdown, sharpeRatio, sortinoRatio, type StrategyStats } from './metrics';
import { StrategyRunner } from './runtime';
import type { AnyStrategy, StrategyInstrument, StrategyLog } from './types';

export type FillModel = 'book' | 'tape';

export interface BacktestConfig {
  instrument: StrategyInstrument;
  bars: BarSpec;
  startingBalance: number;
  /** Commission per contract per side (account currency). */
  commissionPerUnit: number;
  /** Taker fee as a fraction of notional (crypto); maker fills pay half. */
  takerFee: number;
  /** Extra ticks against you on market and stop fills. */
  slippageTicks: number;
  /**
   * 'book': market / stop orders walk the recorded book when the data has one (else top of book
   * is derived from the tape). 'tape': top of book is always derived from the last trade.
   */
  fillModel: FillModel;
  /** Trading window: no orders outside it and flat at its end (walk-forward). */
  window?: { from: number; to: number };
  /** ATM templates strategies may reference with `opts.atm` (plain data: worker-safe). */
  atmTemplates?: AtmTemplate[];
  /** Template id applied to every bracketed entry (exit management override). */
  atmOverride?: string;
}

export const DEFAULT_BACKTEST: Omit<BacktestConfig, 'instrument' | 'bars'> = {
  startingBalance: 50_000,
  commissionPerUnit: 2.5,
  takerFee: 0,
  slippageTicks: 1,
  fillModel: 'book',
};

/** Validates and clamps a (possibly user-edited) config. */
export function sanitizeConfig(c: BacktestConfig): BacktestConfig {
  const num = (v: unknown, def: number, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;
  return {
    ...c,
    startingBalance: num(c.startingBalance, DEFAULT_BACKTEST.startingBalance, 1, 1e12),
    commissionPerUnit: num(c.commissionPerUnit, DEFAULT_BACKTEST.commissionPerUnit, 0, 1e6),
    takerFee: num(c.takerFee, 0, 0, 0.1),
    slippageTicks: Math.round(num(c.slippageTicks, DEFAULT_BACKTEST.slippageTicks, 0, 1000)),
    fillModel: c.fillModel === 'tape' ? 'tape' : 'book',
  };
}

export type ExitReason = 'stop' | 'target' | 'signal' | 'end';

export interface BacktestTrade extends RoundTrip {
  /** 1-based trade number. */
  n: number;
  net: number;
  /** Net / risk, when the entry had a stop. */
  r: number | null;
  entryBar: number;
  exitBar: number;
  entryLabel: string;
  exitLabel: string;
  exitReason: ExitReason;
  maeTicks: number;
  mfeTicks: number;
}

export interface EquitySample {
  /** Bar close time. */
  t: number;
  /** Balance + open P&L. */
  equity: number;
  /** ≤ 0: distance below the running peak. */
  drawdown: number;
}

export interface BacktestResult {
  strategyId: string;
  inputs: RawInputs;
  config: BacktestConfig;
  from: number;
  to: number;
  ticks: number;
  barCount: number;
  trades: BacktestTrade[];
  equity: EquitySample[];
  stats: StrategyStats;
  logs: StrategyLog[];
}

/** Datasets as the replay registry provides them (trades + optional recorded book). */
export type BacktestData = Pick<
  ReplayDataset,
  'trades' | 'snapshots' | 'deltas' | 'initialBook' | 'start' | 'end'
>;

const ACCOUNT = 'backtest';
const BIG = 1e12;

function shift(levels: Iterable<[number, number]>, by: number, n: number): Level[] {
  const out: Level[] = [];
  for (const [px, q] of levels) {
    out.push([px + by, q]);
    if (out.length >= n) break;
  }
  return out;
}

/**
 * Deterministic event-driven backtest: trades (and recorded book events) are replayed in time
 * order through the app's PaperEngine, which fills market / stop orders against the book plus
 * slippage and resting limits when the tape trades through them. Runs in chunks (`step`) so a UI
 * can stay responsive; the result does not depend on the chunking.
 */
export class Backtest {
  readonly config: BacktestConfig;
  readonly engine: PaperEngine;
  readonly runner: StrategyRunner;
  private clock = 0;
  private i = 0;
  private si = 0;
  private di = 0;
  private real = new OrderBook();
  private hasBook: boolean;
  private viewCache: { version: number; book: OrderBook } | null = null;
  private synth = { bid: Number.NaN, ask: Number.NaN };
  private equity: EquitySample[] = [];
  private peak = -Infinity;
  private done = false;
  private finished: BacktestResult | null = null;

  constructor(
    readonly def: AnyStrategy,
    readonly raw: RawInputs | undefined,
    readonly data: BacktestData,
    config: BacktestConfig,
  ) {
    this.config = sanitizeConfig(config);
    const inst = this.config.instrument;
    this.hasBook =
      this.config.fillModel === 'book' &&
      (!!data.initialBook || data.snapshots.length > 0 || data.deltas.length > 0);
    if (this.hasBook && data.initialBook) this.real.applySnapshot(data.initialBook);
    this.engine = new PaperEngine({
      book: () => this.bookView(),
      economics: () => ({ tickSize: inst.tickSize, tickValue: inst.tickValue }),
      now: () => this.clock,
    });
    this.engine.createAccount({
      id: ACCOUNT,
      name: 'Backtest',
      startingBalance: this.config.startingBalance,
      commissionPerUnit: this.config.commissionPerUnit,
      takerFee: this.config.takerFee,
    });
    this.runner = new StrategyRunner(def, raw, {
      engine: this.engine,
      accountId: ACCOUNT,
      instrument: inst,
      bars: this.config.bars,
      window: this.config.window,
      atm: (id) => this.config.atmTemplates?.find((t) => t.id === id),
      atmOverride: this.config.atmOverride,
      tradesBetween: (a, b) => this.tradesBetween(a, b),
      onBarClosed: (_i, bar) => this.sample(bar.tEnd, bar.c),
    });
  }

  /** Fraction of trades processed (0..1). */
  progress(): number {
    const n = this.data.trades.length;
    return n ? Math.min(1, this.i / n) : 1;
  }

  /** Processes trades for up to `budgetMs` of CPU; returns true when finished. */
  step(budgetMs = Infinity): boolean {
    if (this.done) return true;
    const t0 = performance.now();
    const trades = this.data.trades;
    const stopAt = this.config.window ? this.config.window.to : Infinity;
    let k = 0;
    while (this.i < trades.length) {
      const t = trades[this.i++]!;
      this.clock = t.ts;
      this.advanceBook(t);
      this.engine.onTrade(this.config.instrument.id, t);
      this.runner.onTrade(t);
      // Walk-forward windows: nothing can happen after the window has closed and been flattened.
      if (t.ts >= stopAt && this.flat()) break;
      if ((++k & 1023) === 0) {
        this.prune();
        if (performance.now() - t0 > budgetMs) return false;
      }
    }
    this.finish();
    return true;
  }

  /** Runs to the end and returns the result. */
  run(): BacktestResult {
    this.step();
    return this.result();
  }

  result(): BacktestResult {
    if (!this.finished) throw new Error('Backtest not finished');
    return this.finished;
  }

  // ---------------------------------------------------------------- internals

  private flat(): boolean {
    return (
      this.engine.position(ACCOUNT, this.config.instrument.id).qty === 0 &&
      this.engine.workingOrders(ACCOUNT).length === 0
    );
  }

  private tradesBetween(a: number, b: number): readonly Trade[] {
    const tr = this.data.trades;
    let lo = 0;
    let hi = this.i;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (tr[m]!.ts < a) lo = m + 1;
      else hi = m;
    }
    const out: Trade[] = [];
    for (let k = lo; k < this.i && tr[k]!.ts <= b; k++) out.push(tr[k]!);
    return out;
  }

  private advanceBook(t: Trade): void {
    // Top of book derived from the tape (always kept: fallback when the recorded book is empty).
    if (t.side === 'sell') {
      this.synth.bid = t.px;
      this.synth.ask = t.px + 1;
    } else {
      this.synth.ask = t.px;
      this.synth.bid = t.px - 1;
    }
    if (!this.hasBook) return;
    const { snapshots, deltas } = this.data;
    let changed = false;
    while (this.si < snapshots.length && snapshots[this.si]!.ts <= t.ts) {
      this.real.applySnapshot(snapshots[this.si++]!);
      changed = true;
    }
    while (this.di < deltas.length && deltas.ts[this.di]! <= t.ts) {
      this.real.applyDelta(deltas.get(this.di++));
      changed = true;
    }
    if (changed) this.runner.onBook(this.real, t.ts);
    else this.runner.setBook(this.real);
  }

  /** The book the paper engine fills against: recorded (or tape) book shifted by slippage. */
  private bookView(): OrderBook {
    const slip = this.config.slippageTicks;
    const real = this.real;
    const useReal =
      this.hasBook &&
      !Number.isNaN(real.bestBid) &&
      !Number.isNaN(real.bestAsk) &&
      real.bestBid < real.bestAsk;
    const version = useReal ? real.version : -1 - this.i;
    if (this.viewCache?.version === version) return this.viewCache.book;
    let snap: BookSnapshot;
    if (useReal) {
      const bids = [...real.bids.entries()].sort((a, b) => b[0] - a[0]);
      const asks = [...real.asks.entries()].sort((a, b) => a[0] - b[0]);
      snap = { ts: this.clock, bids: shift(bids, -slip, 64), asks: shift(asks, slip, 64) };
    } else {
      snap = {
        ts: this.clock,
        bids: Number.isNaN(this.synth.bid) ? [] : [[this.synth.bid - slip, BIG]],
        asks: Number.isNaN(this.synth.ask) ? [] : [[this.synth.ask + slip, BIG]],
      };
    }
    const book = new OrderBook();
    book.applySnapshot(snap);
    this.viewCache = { version, book };
    return book;
  }

  private sample(t: number, closePx: number): void {
    const acc = this.engine.accounts.get(ACCOUNT)!;
    const eq = acc.balance + this.engine.unrealized(ACCOUNT, this.config.instrument.id, closePx);
    if (eq > this.peak) this.peak = eq;
    this.equity.push({ t, equity: eq, drawdown: eq - this.peak });
  }

  /** Drops finished orders so the engine's per-trade scan stays short on long runs. */
  private prune(): void {
    for (const [id, o] of this.engine.orders)
      if (o.status === 'filled' || o.status === 'cancelled' || o.status === 'rejected')
        this.engine.orders.delete(id);
  }

  private finish(): void {
    if (this.done) return;
    this.done = true;
    const trades = this.data.trades;
    const last = trades[this.i - 1];
    if (last) {
      this.runner.flatten('end of data', true);
      this.sample(last.ts, last.px);
    }
    this.runner.dispose();
    this.finished = this.buildResult();
  }

  private buildResult(): BacktestResult {
    const cfg = this.config;
    const inst = cfg.instrument;
    const ppt = pnlPerTick(inst, 1);
    // Deterministic ids: the engine's ids contain wall-clock time.
    const orderIds = new Map<string, string>();
    const oid = (id: string) => {
      let v = orderIds.get(id);
      if (!v) orderIds.set(id, (v = `o${orderIds.size + 1}`));
      return v;
    };
    const fills: Fill[] = this.engine.fills
      .filter((f) => f.tag === this.runner.tag)
      .map((f, k) => ({ ...f, id: `f${k + 1}`, orderId: oid(f.orderId) }));
    const back = new Map<string, string>();
    for (const [real, mapped] of orderIds) back.set(mapped, real);
    const trips = roundTrips(fills, () => ppt);
    const bars = this.runner.series;
    const tradesOut: BacktestTrade[] = trips.map((t, k) => {
      const entryReal = back.get(t.entryOrderId ?? '') ?? '';
      const exitReal = back.get(t.exitOrderId ?? '') ?? '';
      const stop = this.runner.initialStops.get(entryReal);
      const risk = stop !== undefined ? Math.abs(t.entryPx - stop) * ppt * t.qty : undefined;
      const role = this.runner.roles.get(exitReal);
      const exitLabel = this.runner.labels.get(exitReal) ?? '';
      const exitReason: ExitReason =
        role === 'sl'
          ? 'stop'
          : role === 'tp'
            ? 'target'
            : exitLabel === 'end of data' || exitLabel === 'window end'
              ? 'end'
              : 'signal';
      const trip: RoundTrip = {
        ...t,
        id: `bt-${k + 1}`,
        accountId: ACCOUNT,
        ...(risk && risk > 0 ? { risk } : {}),
      };
      const exc = excursion(trip, this.tradesBetween(t.entryTs, t.exitTs));
      const net = netOf(trip);
      return {
        ...trip,
        n: k + 1,
        net,
        r: risk && risk > 0 ? net / risk : null,
        entryBar: bars.indexAt(t.entryTs),
        exitBar: bars.indexAt(t.exitTs),
        entryLabel: this.runner.labels.get(entryReal) ?? '',
        exitLabel:
          exitLabel || (exitReason === 'stop' ? 'stop' : exitReason === 'target' ? 'target' : ''),
        exitReason,
        maeTicks: exc.maeTicks,
        mfeTicks: exc.mfeTicks,
      };
    });
    const base = journalStats(tradesOut, { startingBalance: cfg.startingBalance });
    const nets = tradesOut.map((t) => t.net);
    const stats: StrategyStats = {
      ...base,
      sharpe: sharpeRatio(nets),
      sortino: sortinoRatio(nets),
      monteCarloDd95: monteCarloDrawdown(nets),
      returnPct: base.netPnl / cfg.startingBalance,
      avgBarsHeld: tradesOut.length
        ? tradesOut.reduce((a, t) => a + (t.exitBar - t.entryBar), 0) / tradesOut.length
        : 0,
    };
    const first = this.data.trades[0];
    return {
      strategyId: this.def.id,
      inputs: { ...this.runner.inputs },
      config: cfg,
      from: first?.ts ?? this.data.start,
      to: this.data.trades[this.i - 1]?.ts ?? this.data.end,
      ticks: this.i,
      barCount: bars.bars.length,
      trades: tradesOut,
      equity: this.equity,
      stats,
      logs: this.runner.logs.slice(),
    };
  }
}

export function runBacktest(
  def: AnyStrategy,
  raw: RawInputs | undefined,
  data: BacktestData,
  config: BacktestConfig,
): BacktestResult {
  return new Backtest(def, raw, data, config).run();
}

/** Runs a backtest in slices of `sliceMs`, yielding to the event loop between them. */
export async function runBacktestAsync(
  def: AnyStrategy,
  raw: RawInputs | undefined,
  data: BacktestData,
  config: BacktestConfig,
  opts: { sliceMs?: number; onProgress?(p: number): void; signal?: AbortSignal } = {},
): Promise<BacktestResult> {
  const bt = new Backtest(def, raw, data, config);
  while (!bt.step(opts.sliceMs ?? 16)) {
    if (opts.signal?.aborted) throw new Error('Backtest cancelled');
    opts.onProgress?.(bt.progress());
    await new Promise((r) => setTimeout(r, 0));
  }
  opts.onProgress?.(1);
  return bt.result();
}

/** CSV of a backtest's trades (RFC 4180, CRLF). */
export function tradesCsv(r: BacktestResult): string {
  const inst = r.config.instrument;
  const p = (px: number) => (px * inst.tickSize).toFixed(inst.pricePrecision);
  const iso = (ts: number) => new Date(ts).toISOString();
  const head = [
    '#',
    'Side',
    'Qty',
    'Entry time',
    'Entry price',
    'Exit time',
    'Exit price',
    'Gross P&L',
    'Commission',
    'Net P&L',
    'R',
    'MAE ticks',
    'MFE ticks',
    'Entry signal',
    'Exit',
  ];
  const cell = (v: string | number) => {
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const lines = [head.join(',')];
  for (const t of r.trades)
    lines.push(
      [
        t.n,
        t.side,
        t.qty,
        iso(t.entryTs),
        p(t.entryPx),
        iso(t.exitTs),
        p(t.exitPx),
        t.pnl.toFixed(2),
        t.commission.toFixed(2),
        t.net.toFixed(2),
        t.r === null ? '' : t.r.toFixed(2),
        t.maeTicks,
        t.mfeTicks,
        t.entryLabel,
        t.exitLabel || t.exitReason,
      ]
        .map(cell)
        .join(','),
    );
  return lines.join('\r\n') + '\r\n';
}

/** CSV of the summary metrics. */
export function summaryCsv(r: BacktestResult): string {
  const s = r.stats;
  const rows: [string, string | number][] = [
    ['Strategy', r.strategyId],
    ['Inputs', JSON.stringify(r.inputs)],
    ['From', new Date(r.from).toISOString()],
    ['To', new Date(r.to).toISOString()],
    ['Ticks', r.ticks],
    ['Bars', r.barCount],
    ['Trades', s.trades],
    ['Net P&L', s.netPnl.toFixed(2)],
    ['Win rate', (s.winRate * 100).toFixed(1) + '%'],
    ['Profit factor', Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : 'inf'],
    ['Expectancy', s.expectancy.toFixed(2)],
    ['Expectancy R', Number.isNaN(s.expectancyR) ? '' : s.expectancyR.toFixed(2)],
    ['Max drawdown', s.maxDrawdown.toFixed(2)],
    ['Sharpe (per trade)', s.sharpe.toFixed(3)],
    ['Sortino (per trade)', Number.isFinite(s.sortino) ? s.sortino.toFixed(3) : 'inf'],
    ['Monte-Carlo DD 95%', s.monteCarloDd95.toFixed(2)],
    ['Commission', s.commission.toFixed(2)],
  ];
  return 'Metric,Value\r\n' + rows.map(([k, v]) => `${k},"${String(v)}"`).join('\r\n') + '\r\n';
}
