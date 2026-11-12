import type { RawInputs } from '@htflow/indicator-sdk';
import type { BarSpec, MarketStore } from '@htflow/market-data';
import { StrategyRunner, strategyById, type StrategyLog } from '@htflow/strategy';
import { roundTrips, netOf, type RoundTrip } from '@htflow/trading';
import { paper, PAPER_ACCOUNT, pnlTick } from '../../state/market';
import { templateById } from '../../trading/atmStore';
import { toStrategyInstrument } from './shared';

/** One strategy running live on paper from a chart (P42 "Run on paper", This PC). */
export interface LiveRun {
  /** Chart window id. */
  key: string;
  strategyId: string;
  instrumentId: string;
  accountId: string;
  inputs: RawInputs;
  startedAt: number;
  status: 'running' | 'error';
  error?: string;
  tag: string;
  runner: StrategyRunner;
}

const runs = new Map<string, LiveRun>();
const disposers = new Map<string, () => void>();
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version++;
  for (const l of listeners) l();
}

export const liveRuns = {
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  version: () => version,
  list: (): LiveRun[] => [...runs.values()],
  get: (key: string): LiveRun | undefined => runs.get(key),

  /**
   * Starts (or restarts) a strategy on a chart's store. The runner first replays the store's
   * history with orders disabled (warm-up: bars, indicators, state), then trades live on paper.
   */
  start(
    key: string,
    store: MarketStore,
    strategyId: string,
    inputs: RawInputs,
    bars: BarSpec,
  ): void {
    this.stop(key);
    const def = strategyById(strategyId);
    if (!def) return;
    const tag = `strategy:${strategyId}:${key}`;
    const runner = new StrategyRunner(def, inputs, {
      engine: paper,
      accountId: PAPER_ACCOUNT,
      instrument: toStrategyInstrument(store.instrument),
      bars,
      tag,
      atm: templateById,
      tradesBetween: (a, b) => store.tradesBetween(a, b),
      onLog: () => notify(),
    });
    runner.warmup = true;
    for (const t of store.trades) runner.onTrade(t);
    runner.warmup = false;
    runner.setBook(store.book);
    const run: LiveRun = {
      key,
      strategyId,
      instrumentId: store.instrument.id,
      accountId: PAPER_ACCOUNT,
      inputs,
      startedAt: Date.now(),
      status: 'running',
      tag,
      runner,
    };
    runs.set(key, run);
    const off = store.onTrades((trades) => {
      try {
        for (const t of trades) runner.onTrade(t);
      } catch (e) {
        run.status = 'error';
        run.error = e instanceof Error ? e.message : String(e);
        off();
        notify();
      }
    });
    disposers.set(key, () => {
      off();
      runner.dispose();
    });
    notify();
  },

  /** Stops a run; `flatten` also closes its position and cancels its orders. */
  stop(key: string, flatten = false): void {
    const run = runs.get(key);
    if (!run) return;
    if (flatten) run.runner.flatten('strategy stopped', true);
    disposers.get(key)?.();
    disposers.delete(key);
    runs.delete(key);
    notify();
  },

  stopAll(flatten = true): void {
    for (const k of [...runs.keys()]) this.stop(k, flatten);
  },
};

/** Closed paper round trips of a live run (tagged fills only). */
export function liveTrips(tag: string): RoundTrip[] {
  return roundTrips(
    paper.fills.filter((f) => f.tag === tag),
    pnlTick,
  );
}

export function liveSummary(run: LiveRun): {
  trades: number;
  net: number;
  today: number;
  openPnl: number;
  position: number;
  logs: StrategyLog[];
} {
  const trips = liveTrips(run.tag);
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const pos = run.runner.position();
  return {
    trades: trips.length,
    net: trips.reduce((a, t) => a + netOf(t), 0),
    today: trips.filter((t) => t.exitTs >= dayStart.getTime()).reduce((a, t) => a + netOf(t), 0),
    openPnl: pos.openPnl,
    position: pos.qty,
    logs: run.runner.logs,
  };
}
