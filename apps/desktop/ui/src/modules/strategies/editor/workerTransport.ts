import {
  type CallResult,
  type CompiledProject,
  type HostEvent,
  type SandboxLimits,
  type SandboxRequest,
  type SandboxResponse,
  type ScriptDescription,
  type ScriptError,
  type ScriptTransport,
  type StrategyInstrument,
} from '@htflow/strategy';

interface Pending {
  resolve(v: SandboxResponse): void;
  reject(e: ScriptError): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Main-thread end of the sandbox: one dedicated Web Worker per run. Every request has a watchdog;
 * a callback that does not answer within its CPU budget (plus message latency) gets the worker
 * terminated — the only way to stop a runaway synchronous loop.
 */
export class WorkerTransport implements ScriptTransport {
  readonly sync = false;
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private budgetMs = 250;
  private dead: ScriptError | null = null;

  constructor() {
    this.worker = new Worker(new URL('./sandbox.worker.ts', import.meta.url), {
      type: 'module',
      name: 'ht-strategy-sandbox',
    });
    this.worker.onmessage = (e: MessageEvent<SandboxResponse>) => {
      const r = e.data;
      if (!r || typeof r !== 'object' || typeof r.seq !== 'number') return;
      const p = this.pending.get(r.seq);
      if (!p) return;
      this.pending.delete(r.seq);
      clearTimeout(p.timer);
      p.resolve(r);
    };
    this.worker.onerror = (e) => {
      e.preventDefault();
      this.kill({ message: `Sandbox crashed: ${e.message || 'worker error'}`, kind: 'protocol' });
    };
  }

  private kill(err: ScriptError): void {
    if (this.dead) return;
    this.dead = err;
    this.worker.terminate();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private request(req: SandboxRequest, timeoutMs: number, what: string): Promise<SandboxResponse> {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.kill({
            message: `${what} did not finish within ${timeoutMs} ms: the sandbox was terminated (infinite loop or CPU budget exceeded)`,
            kind: 'budget',
          }),
        timeoutMs,
      );
      this.pending.set(req.seq, { resolve, reject, timer });
      this.worker.postMessage(req);
    });
  }

  async load(
    project: CompiledProject,
    params: Record<string, unknown>,
    instrument: StrategyInstrument,
    limits: SandboxLimits,
  ): Promise<ScriptDescription> {
    this.budgetMs = limits.budgetMs;
    const r = await this.request(
      {
        seq: ++this.seq,
        type: 'load',
        project,
        params,
        instrument: {
          symbol: instrument.symbol,
          tickSize: instrument.tickSize,
          tickValue: instrument.tickValue,
          pricePrecision: instrument.pricePrecision,
        },
        limits,
      },
      Math.max(5000, limits.budgetMs * 20),
      'Loading the strategy',
    );
    if (r.type !== 'loaded') throw { message: 'Unexpected sandbox reply', kind: 'protocol' };
    if (r.error || !r.description) throw r.error ?? { message: 'Load failed', kind: 'load' };
    return r.description;
  }

  async call(event: HostEvent): Promise<CallResult> {
    const budget = event.kind === 'start' ? this.budgetMs * 10 : this.budgetMs;
    const r = await this.request(
      { seq: ++this.seq, type: 'call', event },
      budget + 1500,
      `${event.kind} callback`,
    );
    if (r.type !== 'result' || !r.result || typeof r.result !== 'object')
      throw { message: 'Unexpected sandbox reply', kind: 'protocol' } satisfies ScriptError;
    return r.result;
  }

  dispose(): void {
    this.kill({ message: 'Stopped', kind: 'protocol' });
  }
}
