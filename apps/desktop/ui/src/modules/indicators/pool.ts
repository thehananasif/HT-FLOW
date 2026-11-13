/**
 * App-wide indicator worker pool (Stage 8). Created on first use with
 * `performance.workerCount` workers when `performance.indicatorWorkers` is on and the platform
 * has Web Workers; otherwise (tests, old webviews) indicators run on the main thread.
 */
import {
  IndicatorPool,
  type EngineTransport,
  type FromEngine,
  type ToEngine,
} from '@htflow/indicator-sdk';
import { getSetting } from '../../state/settings';

class WorkerTransport implements EngineTransport {
  private w: Worker;
  constructor() {
    this.w = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' });
  }
  post(msg: ToEngine): void {
    this.w.postMessage(msg);
  }
  onMessage(fn: (m: FromEngine) => void): void {
    this.w.onmessage = (e: MessageEvent<FromEngine>) => fn(e.data);
  }
  terminate(): void {
    this.w.terminate();
  }
}

let pool: IndicatorPool | null | undefined;

export function indicatorPool(): IndicatorPool | null {
  if (pool !== undefined) return pool;
  const on = getSetting('performance.indicatorWorkers') !== false;
  if (!on || typeof Worker === 'undefined') return (pool = null);
  try {
    const n = Math.max(1, Math.min(8, Number(getSetting('performance.workerCount')) || 2));
    pool = new IndicatorPool(() => new WorkerTransport(), n);
  } catch {
    pool = null;
  }
  return pool;
}

/** For the debug readout / tests: whether indicators currently run in workers. */
export function poolSize(): number {
  return pool ? pool.size : 0;
}
