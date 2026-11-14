import type { RawInputs } from '@htflow/indicator-sdk';
import { OrderBook, type BarSpec, type Trade } from '@htflow/market-data';
import { StrategyRunner, strategyById, type StrategyInstrument } from '@htflow/strategy';
import { PaperEngine, netOf, pnlPerTick, roundTrips, type RoundTrip } from '@htflow/trading';

/**
 * Headless runner core (P42 VPS runner). Pure and platform-free: the Node entry (`main.ts`)
 * feeds it public exchange trades and persists what it emits; tests feed it synthetic trades.
 * Trading is PAPER only — fills are simulated by the same `PaperEngine` the app uses, against a
 * top-of-book derived from the tape (like the backtester without a recorded book).
 */

export const RUNNER_PROTOCOL = 1;

/** Public market-data source the runner subscribes to on the VPS. */
export interface FeedSpec {
  exchange: 'binance-futures' | 'binance-spot' | 'bybit-linear' | 'bybit-spot' | 'okx';
  /** Exchange symbol (`BTCUSDT`, `BTC-USDT-SWAP`). */
  symbol: string;
}

/** Everything a deployed runner needs, embedded in its bundle. */
export interface RunnerConfig {
  v: typeof RUNNER_PROTOCOL;
  runnerId: string;
  vpsId: string;
  strategyId: string;
  strategyName: string;
  inputs: RawInputs;
  instrument: StrategyInstrument;
  feed: FeedSpec;
  bars: BarSpec;
  account: { startingBalance: number; commissionPerUnit: number; takerFee: number };
  /** Max contracts the runner may hold (risk cap enforced on the VPS). */
  maxPosition: number;
  deployedAt: number;
}

export type RunnerStatus = 'starting' | 'running' | 'stopped' | 'error';

/** Snapshot written to `state.json` (and parsed by the app's status poll). */
export interface RunnerState {
  v: typeof RUNNER_PROTOCOL;
  runnerId: string;
  strategyId: string;
  strategyName: string;
  symbol: string;
  exchange: string;
  status: RunnerStatus;
  pid: number;
  startedAt: number;
  updatedAt: number;
  feed: { connected: boolean; lastTradeTs: number; reconnects: number; trades: number };
  lastPx: number;
  position: { qty: number; avgPx: number; openPnl: number };
  realized: number;
  trips: number;
  wins: number;
  error?: string;
}

export interface LogLine {
  ts: number;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

export interface RunnerIO {
  writeState(json: string): void;
  appendLog(line: string): void;
  appendTrip(line: string): void;
}

const ACCOUNT = 'vps';
const BIG = 1e12;

export class HeadlessRunner {
  readonly engine: PaperEngine;
  readonly runner: StrategyRunner;
  private clock = 0;
  private bid = Number.NaN;
  private ask = Number.NaN;
  private emitted: number;
  private state: RunnerState;

  constructor(
    readonly cfg: RunnerConfig,
    private io: RunnerIO,
    opts: { pid?: number; now?: number; tripsDone?: number } = {},
  ) {
    const def = strategyById(cfg.strategyId);
    if (!def) throw new Error(`Unknown strategy '${cfg.strategyId}'`);
    const inst = cfg.instrument;
    this.engine = new PaperEngine({
      book: () => this.book(),
      economics: () => ({ tickSize: inst.tickSize, tickValue: inst.tickValue }),
      now: () => this.clock,
    });
    this.engine.createAccount({
      id: ACCOUNT,
      name: 'VPS',
      startingBalance: cfg.account.startingBalance,
      commissionPerUnit: cfg.account.commissionPerUnit,
      takerFee: cfg.account.takerFee,
    });
    this.runner = new StrategyRunner(def, cfg.inputs, {
      engine: this.engine,
      accountId: ACCOUNT,
      instrument: inst,
      bars: cfg.bars,
      tag: `vps:${cfg.runnerId}`,
      onLog: (l) => this.log('info', l.text, l.ts),
    });
    // Trips already in trips.jsonl from an earlier process are not re-emitted (ids restart).
    this.emitted = 0;
    const now = opts.now ?? Date.now();
    this.state = {
      v: RUNNER_PROTOCOL,
      runnerId: cfg.runnerId,
      strategyId: cfg.strategyId,
      strategyName: cfg.strategyName,
      symbol: cfg.feed.symbol,
      exchange: cfg.feed.exchange,
      status: 'starting',
      pid: opts.pid ?? 0,
      startedAt: now,
      updatedAt: now,
      feed: { connected: false, lastTradeTs: 0, reconnects: 0, trades: 0 },
      lastPx: Number.NaN,
      position: { qty: 0, avgPx: 0, openPnl: 0 },
      realized: 0,
      trips: opts.tripsDone ?? 0,
      wins: 0,
    };
  }

  private book(): OrderBook {
    const b = new OrderBook();
    b.applySnapshot({
      ts: this.clock,
      bids: Number.isNaN(this.bid) ? [] : [[this.bid, BIG]],
      asks: Number.isNaN(this.ask) ? [] : [[this.ask, BIG]],
    });
    return b;
  }

  log(level: LogLine['level'], msg: string, ts = Date.now()): void {
    const line: LogLine = { ts, level, msg: msg.slice(0, 2000) };
    this.io.appendLog(JSON.stringify(line));
  }

  /** One public trade (time order). Fills resting orders, then runs the strategy. */
  onTrade(t: Trade): void {
    if (this.state.status === 'stopped' || this.state.status === 'error') return;
    this.clock = t.ts;
    if (t.side === 'sell') {
      this.bid = t.px;
      this.ask = t.px + 1;
    } else {
      this.ask = t.px;
      this.bid = t.px - 1;
    }
    this.engine.onTrade(this.cfg.instrument.id, t);
    this.runner.onTrade(t);
    this.enforceRisk();
    this.state.status = 'running';
    this.state.lastPx = t.px;
    this.state.feed.lastTradeTs = t.ts;
    this.state.feed.trades++;
    this.collectTrips();
  }

  /** Risk cap on the VPS: a position above `maxPosition` is flattened and the run stops. */
  private enforceRisk(): void {
    const q = Math.abs(this.runner.position().qty);
    if (this.cfg.maxPosition > 0 && q > this.cfg.maxPosition) {
      this.log('error', `Position ${q} exceeds the risk cap ${this.cfg.maxPosition}: flattening`);
      this.runner.flatten('risk cap', true);
      this.fail(`Risk cap exceeded (${q} > ${this.cfg.maxPosition})`);
    }
  }

  private collectTrips(): void {
    const all = roundTrips(this.engine.fills, () =>
      pnlPerTick(this.cfg.instrument, 1),
    ) as RoundTrip[];
    for (let i = this.emitted; i < all.length; i++) {
      const t = all[i]!;
      this.io.appendTrip(JSON.stringify(t));
      this.state.trips++;
      if (netOf(t) > 0) this.state.wins++;
      this.log('info', `Closed ${t.side} ${t.qty} @ ${t.exitPx}: ${netOf(t).toFixed(2)}`, t.exitTs);
    }
    this.emitted = all.length;
  }

  setFeed(connected: boolean, detail?: string): void {
    if (this.state.feed.connected !== connected) {
      if (!connected) this.state.feed.reconnects++;
      this.log(connected ? 'info' : 'warn', detail ?? (connected ? 'Feed connected' : 'Feed lost'));
    }
    this.state.feed.connected = connected;
  }

  fail(error: string): void {
    this.state.status = 'error';
    this.state.error = error.slice(0, 500);
    this.log('error', error);
    this.flush();
  }

  /** Graceful stop: flatten the paper position, record the last trips, write the state. */
  stop(reason: string): void {
    if (this.state.status !== 'error') {
      this.runner.flatten(reason, true);
      this.collectTrips();
      this.state.status = 'stopped';
    }
    this.runner.dispose();
    this.log('info', `Stopped: ${reason}`);
    this.flush();
  }

  snapshot(now = Date.now()): RunnerState {
    const p = this.runner.position();
    const acc = this.engine.accounts.get(ACCOUNT)!;
    return {
      ...this.state,
      updatedAt: now,
      position: { qty: p.qty, avgPx: p.avgPx, openPnl: p.openPnl },
      realized: acc.balance - this.cfg.account.startingBalance,
    };
  }

  /** Writes `state.json` (called every few seconds and on every status change). */
  flush(now = Date.now()): void {
    this.io.writeState(JSON.stringify(this.snapshot(now)));
  }
}
