import type { BarSpec } from '@htflow/market-data';
import {
  DEFAULT_LIMITS,
  ScriptBridge,
  StrategyRunner,
  accountOf,
  type CompiledProject,
  type LogEntry,
  type OrderLimits,
  type ScriptTransport,
} from '@htflow/strategy';
import { netOf, roundTrips, type PaperEngine } from '@htflow/trading';
import { hub, paper, pnlTick } from '../../../state/market';
import { instrumentById } from '../../../state/instruments';
import { activeAccount } from '../../../trading/accounts';
import { toStrategyInstrument } from '../shared';
import { WorkerTransport } from './workerTransport';

/**
 * A connector that can route real orders. It exposes a PaperEngine-compatible order engine that
 * mirrors the venue (orders out, fills in), so strategies, validation and the RiskEngine run
 * unchanged. No connector implements live order routing yet (docs/BLOCKERS.md): the registry is
 * empty and the Live mode stays disabled.
 */
export interface LiveOrderRouter {
  id: string;
  label: string;
  accountId: string;
  engine: PaperEngine;
  instruments(): string[];
}

const routers = new Map<string, LiveOrderRouter>();

export function registerLiveRouter(r: LiveOrderRouter): () => void {
  routers.set(r.id, r);
  notify();
  return () => {
    routers.delete(r.id);
    notify();
  };
}

export const liveRouters = (): LiveOrderRouter[] => [...routers.values()];

export type RunMode = 'paper' | 'live';

export interface ScriptRun {
  id: string;
  projectId: string;
  name: string;
  mode: RunMode;
  instrumentId: string;
  accountId: string;
  status: 'starting' | 'running' | 'stopped' | 'error';
  error?: string;
  startedAt: number;
  stoppedAt?: number;
  tag: string;
  logs: LogEntry[];
  bridge: ScriptBridge | null;
  runner: StrategyRunner | null;
  engine: PaperEngine;
}

const runs = new Map<string, ScriptRun>();
const disposers = new Map<string, () => void>();
const listeners = new Set<() => void>();
let version = 0;
let seq = 0;

function notify(): void {
  version++;
  for (const l of listeners) l();
}

export interface StartOptions {
  projectId: string;
  name: string;
  project: CompiledProject;
  params: Record<string, unknown>;
  instrumentId: string;
  bars?: BarSpec;
  limits: OrderLimits;
  budgetMs?: number;
  mode: RunMode;
  /** Live only: the armed router. */
  router?: LiveOrderRouter;
  /** Test seam: sandbox transport (default: a dedicated Web Worker). */
  transport?: ScriptTransport;
}

async function whenReady(instrumentId: string, timeoutMs = 30_000) {
  const store = hub.acquire(instrumentId);
  const t0 = Date.now();
  while (!store.ready && Date.now() - t0 < timeoutMs) await new Promise((r) => setTimeout(r, 200));
  if (!store.ready) {
    hub.release(instrumentId);
    throw new Error(store.error ?? 'Market data did not load');
  }
  return store;
}

export const scriptRuns = {
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  version: () => version,
  list: (): ScriptRun[] => [...runs.values()].sort((a, b) => b.startedAt - a.startedAt),
  get: (id: string) => runs.get(id),
  active: (): ScriptRun[] =>
    [...runs.values()].filter((r) => r.status === 'running' || r.status === 'starting'),

  /** Starts a script on the live feed: paper engine, or an armed live router. */
  async start(o: StartOptions): Promise<ScriptRun> {
    if (o.mode === 'live' && !o.router) throw new Error('Live trading needs an armed connector');
    const inst = instrumentById(o.instrumentId);
    if (!inst) throw new Error(`Unknown instrument ${o.instrumentId}`);
    const id = `run-${Date.now().toString(36)}-${++seq}`;
    const engine = o.mode === 'live' ? o.router!.engine : paper;
    const accountId = o.mode === 'live' ? o.router!.accountId : activeAccount();
    const run: ScriptRun = {
      id,
      projectId: o.projectId,
      name: o.name,
      mode: o.mode,
      instrumentId: o.instrumentId,
      accountId,
      status: 'starting',
      startedAt: Date.now(),
      tag: `script:${o.projectId}:${id}`,
      logs: [],
      bridge: null,
      runner: null,
      engine,
    };
    runs.set(id, run);
    notify();
    const transport = o.transport ?? new WorkerTransport();
    const fail = (msg: string) => {
      run.status = 'error';
      run.error = msg;
      this.stop(id, true, msg);
    };
    try {
      const sInst = toStrategyInstrument(inst);
      const desc = await transport.load(o.project, o.params, sInst, {
        ...DEFAULT_LIMITS,
        budgetMs: o.budgetMs ?? DEFAULT_LIMITS.budgetMs,
      });
      const store = await whenReady(o.instrumentId);
      let runner: StrategyRunner | null = null;
      const bridge = new ScriptBridge(desc, transport, {
        instrument: sInst,
        limits: o.limits,
        account: () => accountOf(engine, accountId, o.instrumentId, runner?.last),
        onLog: (l) => {
          run.logs.push(l);
          if (run.logs.length > 2000) run.logs.splice(0, run.logs.length - 2000);
          notify();
        },
        onError: (e) => fail(e.line ? `${e.message} (line ${e.line})` : e.message),
      });
      runner = new StrategyRunner(
        bridge.strategy(),
        {},
        {
          engine,
          accountId,
          instrument: sInst,
          bars: o.bars ?? bridge.spec,
          tag: run.tag,
          tradesBetween: (a, b) => store.tradesBetween(a, b),
        },
      );
      bridge.attach(runner);
      run.bridge = bridge;
      run.runner = runner;
      // Warm-up on the session's history: bars and indicators only, no events, no orders.
      bridge.silent = true;
      runner.warmup = true;
      for (const t of store.trades) runner.onTrade(t);
      runner.warmup = false;
      bridge.silent = false;
      runner.setBook(store.book);
      const off = store.onTrades((trades) => {
        if (run.status !== 'running') return;
        try {
          for (const t of trades) runner!.onTrade(t);
          void bridge.drain();
        } catch (e) {
          fail(e instanceof Error ? e.message : String(e));
        }
      });
      disposers.set(id, () => {
        off();
        runner!.dispose();
        transport.dispose();
        hub.release(o.instrumentId);
      });
      if (run.status === 'starting') run.status = 'running';
      await bridge.start();
      notify();
    } catch (e) {
      const err = e as { message?: string; line?: number };
      if (!disposers.has(id)) transport.dispose();
      fail(
        err?.message ? (err.line ? `${err.message} (line ${err.line})` : err.message) : String(e),
      );
    }
    return run;
  },

  /** Stops a run; `flatten` closes its position and cancels its working orders. */
  stop(id: string, flatten = true, reason = 'stopped'): void {
    const run = runs.get(id);
    if (!run) return;
    if (flatten && run.runner) run.runner.flatten(`strategy ${reason}`, true);
    if (run.bridge && run.status === 'running')
      void Promise.resolve(run.bridge.stop()).catch(() => {});
    disposers.get(id)?.();
    disposers.delete(id);
    if (run.status !== 'error') run.status = 'stopped';
    run.stoppedAt = Date.now();
    notify();
  },

  /** Kill switch: stops every script run and flattens. Returns how many were running. */
  killAll(): number {
    const act = this.active();
    for (const r of act) this.stop(r.id, true, 'killed');
    return act.length;
  },

  remove(id: string): void {
    this.stop(id, false);
    runs.delete(id);
    notify();
  },
};

/** Closed round trips of a run (its tagged fills). */
export function runStats(run: ScriptRun): { trades: number; net: number; position: number } {
  const trips = roundTrips(
    run.engine.fills.filter((f) => f.tag === run.tag),
    pnlTick,
  );
  return {
    trades: trips.length,
    net: trips.reduce((a, t) => a + netOf(t), 0),
    position: run.runner?.position().qty ?? 0,
  };
}
