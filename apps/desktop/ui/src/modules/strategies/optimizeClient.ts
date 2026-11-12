import {
  Optimizer,
  WalkForward,
  strategyById,
  toPlainData,
  type BacktestData,
  type OptimizeRow,
} from '@htflow/strategy';
import type { OptimizeJob } from './optimizer.worker';

export interface OptimizeOutput {
  rows: OptimizeRow[];
  folds?: WalkForward['folds'];
  /** Where it ran: a Web Worker, or chunked on the UI thread when workers are unavailable. */
  ranOn: 'worker' | 'main';
}

type JobIn = Omit<OptimizeJob, 'data'> & { data: BacktestData };

/** Grid search (and optional walk-forward) in a Web Worker, falling back to UI-thread chunks. */
export function runOptimization(
  job: JobIn,
  onProgress: (p: number) => void,
  signal: AbortSignal,
): Promise<OptimizeOutput> {
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL('./optimizer.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    worker = null;
  }
  if (!worker) return runOnMain(job, onProgress, signal);
  const w = worker;
  return new Promise<OptimizeOutput>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      w.terminate();
      fn();
    };
    signal.addEventListener('abort', () => finish(() => reject(new Error('Cancelled'))));
    w.onmessage = (e: MessageEvent) => {
      const m = e.data as
        | { kind: 'progress'; p: number }
        | { kind: 'done'; rows: OptimizeRow[]; folds?: WalkForward['folds'] }
        | { kind: 'error'; message: string };
      if (m.kind === 'progress') onProgress(m.p);
      else if (m.kind === 'done')
        finish(() => resolve({ rows: m.rows, folds: m.folds, ranOn: 'worker' }));
      else finish(() => reject(new Error(m.message)));
    };
    // A worker that fails to load (e.g. blocked by CSP) falls back to the UI thread.
    w.onerror = (ev) => {
      ev.preventDefault();
      finish(() => void runOnMain(job, onProgress, signal).then(resolve, reject));
    };
    const msg: OptimizeJob = { ...job, data: toPlainData(job.data) };
    w.postMessage(msg);
  });
}

async function runOnMain(
  job: JobIn,
  onProgress: (p: number) => void,
  signal: AbortSignal,
): Promise<OptimizeOutput> {
  const def = strategyById(job.strategyId);
  if (!def) throw new Error(`Unknown strategy ${job.strategyId}`);
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const opt = new Optimizer(def, job.base, job.ranges, job.data, job.config, job.objective);
  const half = job.walkForward ? 0.5 : 1;
  while (!opt.step(16)) {
    if (signal.aborted) throw new Error('Cancelled');
    onProgress(opt.progress() * half);
    await tick();
  }
  let folds: WalkForward['folds'] | undefined;
  if (job.walkForward) {
    const wf = new WalkForward(
      def,
      job.base,
      job.ranges,
      job.data,
      job.config,
      job.objective,
      job.walkForward,
    );
    while (!wf.step(16)) {
      if (signal.aborted) throw new Error('Cancelled');
      onProgress(0.5 + wf.progress() / 2);
      await tick();
    }
    folds = wf.folds;
  }
  return { rows: opt.rows, folds, ranOn: 'main' };
}
