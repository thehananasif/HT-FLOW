import {
  Optimizer,
  WalkForward,
  fromPlainData,
  strategyById,
  type BacktestConfig,
  type Objective,
  type ParamRange,
  type PlainData,
  type WalkForwardOptions,
} from '@htflow/strategy';
import type { RawInputs } from '@htflow/indicator-sdk';

export interface OptimizeJob {
  strategyId: string;
  base: RawInputs;
  ranges: ParamRange[];
  data: PlainData;
  config: BacktestConfig;
  objective: Objective;
  /** Walk-forward when set (folds ≥ 1). */
  walkForward?: WalkForwardOptions;
}

interface WorkerScope {
  postMessage(message: unknown): void;
  onmessage: ((e: MessageEvent<OptimizeJob>) => void) | null;
}
const ctx = self as unknown as WorkerScope;

ctx.onmessage = (e: MessageEvent<OptimizeJob>) => {
  const job = e.data;
  try {
    const def = strategyById(job.strategyId);
    if (!def) throw new Error(`Unknown strategy ${job.strategyId}`);
    const data = fromPlainData(job.data);
    const opt = new Optimizer(def, job.base, job.ranges, data, job.config, job.objective);
    while (!opt.step(100))
      ctx.postMessage({
        kind: 'progress',
        p: job.walkForward ? opt.progress() / 2 : opt.progress(),
      });
    let folds: WalkForward['folds'] | undefined;
    if (job.walkForward) {
      const wf = new WalkForward(
        def,
        job.base,
        job.ranges,
        data,
        job.config,
        job.objective,
        job.walkForward,
      );
      while (!wf.step(100)) ctx.postMessage({ kind: 'progress', p: 0.5 + wf.progress() / 2 });
      folds = wf.folds;
    }
    ctx.postMessage({ kind: 'done', rows: opt.rows, folds });
  } catch (err) {
    ctx.postMessage({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
