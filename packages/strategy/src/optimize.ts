import { resolveInputs, type InputDefs, type RawInputs } from '@htflow/indicator-sdk';
import { Backtest, type BacktestConfig, type BacktestData, type BacktestResult } from './backtest';
import type { StrategyStats } from './metrics';
import type { AnyStrategy } from './types';

export interface ParamRange {
  key: string;
  from: number;
  to: number;
  step: number;
}

export type Objective = 'netPnl' | 'profitFactor' | 'sharpe' | 'sortino' | 'expectancy' | 'winRate';

export const OBJECTIVES: { value: Objective; label: string }[] = [
  { value: 'netPnl', label: 'Net P&L' },
  { value: 'profitFactor', label: 'Profit factor' },
  { value: 'sharpe', label: 'Sharpe' },
  { value: 'sortino', label: 'Sortino' },
  { value: 'expectancy', label: 'Expectancy' },
  { value: 'winRate', label: 'Win rate' },
];

/** Max values per parameter and combinations per grid (keeps a run bounded). */
export const GRID_LIMITS = { perParam: 50, combos: 2500 };

const decimals = (x: number) => (String(x).split('.')[1] ?? '').length;

/** Inclusive values of one range, snapped to the step's decimals; at most GRID_LIMITS.perParam. */
export function gridValues(r: Pick<ParamRange, 'from' | 'to' | 'step'>): number[] {
  const step = Math.abs(r.step) || 1;
  const lo = Math.min(r.from, r.to);
  const hi = Math.max(r.from, r.to);
  const d = Math.max(decimals(step), decimals(lo));
  const out: number[] = [];
  for (let k = 0; out.length < GRID_LIMITS.perParam; k++) {
    const v = Number((lo + k * step).toFixed(d));
    if (v > hi + 1e-9) break;
    out.push(v);
  }
  return out;
}

/**
 * Cartesian grid of inputs: every combination of the ranges on top of `base`, validated through
 * the strategy's input definitions (so out-of-range values clamp and duplicates collapse).
 */
export function buildGrid(defs: InputDefs, base: RawInputs, ranges: ParamRange[]): RawInputs[] {
  let combos: RawInputs[] = [{ ...base }];
  for (const r of ranges) {
    if (!(r.key in defs)) continue;
    const vals = gridValues(r);
    const next: RawInputs[] = [];
    for (const c of combos)
      for (const v of vals) {
        if (next.length >= GRID_LIMITS.combos) break;
        next.push({ ...c, [r.key]: v });
      }
    combos = next;
  }
  const seen = new Set<string>();
  const out: RawInputs[] = [];
  for (const c of combos) {
    const v = resolveInputs(defs, c) as RawInputs;
    const k = JSON.stringify(v);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

/** Score of a run under an objective (higher is better; no trades scores −Infinity). */
export function scoreOf(s: StrategyStats, objective: Objective): number {
  if (!s.trades) return -Infinity;
  switch (objective) {
    case 'netPnl':
      return s.netPnl;
    case 'profitFactor':
      return Number.isFinite(s.profitFactor) ? s.profitFactor : 1e6;
    case 'sharpe':
      return s.sharpe;
    case 'sortino':
      return Number.isFinite(s.sortino) ? s.sortino : 1e6;
    case 'expectancy':
      return s.expectancy;
    case 'winRate':
      return s.winRate;
  }
}

export interface OptimizeRow {
  inputs: RawInputs;
  stats: StrategyStats;
  score: number;
}

/** Best row first; ties keep grid order (deterministic). */
export function rankRows(rows: readonly OptimizeRow[]): OptimizeRow[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.score - a.r.score || a.i - b.i)
    .map((x) => x.r);
}

/**
 * Grid search over inputs, one backtest per combination, run in slices (`step`) so a UI or a
 * worker can report progress between them.
 */
export class Optimizer {
  readonly grid: RawInputs[];
  readonly rows: OptimizeRow[] = [];
  private cur: Backtest | null = null;

  constructor(
    readonly def: AnyStrategy,
    base: RawInputs,
    ranges: ParamRange[],
    readonly data: BacktestData,
    readonly config: BacktestConfig,
    readonly objective: Objective = 'netPnl',
    grid?: RawInputs[],
  ) {
    this.grid = grid ?? buildGrid(def.inputs, base, ranges);
  }

  get done(): boolean {
    return this.rows.length >= this.grid.length;
  }

  progress(): number {
    if (!this.grid.length) return 1;
    return Math.min(1, (this.rows.length + (this.cur?.progress() ?? 0)) / this.grid.length);
  }

  step(budgetMs = Infinity): boolean {
    const t0 = performance.now();
    while (!this.done) {
      if (!this.cur)
        this.cur = new Backtest(this.def, this.grid[this.rows.length], this.data, this.config);
      const left = budgetMs - (performance.now() - t0);
      if (!this.cur.step(Math.max(1, left))) return false;
      const res = this.cur.result();
      this.rows.push({
        inputs: this.grid[this.rows.length]!,
        stats: res.stats,
        score: scoreOf(res.stats, this.objective),
      });
      this.cur = null;
      if (performance.now() - t0 > budgetMs) return this.done;
    }
    return true;
  }

  best(): OptimizeRow | null {
    return rankRows(this.rows)[0] ?? null;
  }
}

export interface Heatmap {
  xKey: string;
  yKey: string;
  xs: number[];
  ys: number[];
  /** cells[y][x]: best score among rows with those two values (NaN when none). */
  cells: number[][];
  min: number;
  max: number;
}

/** Two-parameter heatmap of an optimisation (other parameters: best score wins). */
export function heatmapOf(rows: readonly OptimizeRow[], xKey: string, yKey: string): Heatmap {
  const xs = [...new Set(rows.map((r) => Number(r.inputs[xKey])))].sort((a, b) => a - b);
  const ys = [...new Set(rows.map((r) => Number(r.inputs[yKey])))].sort((a, b) => a - b);
  const cells = ys.map(() => xs.map(() => Number.NaN));
  let min = Infinity;
  let max = -Infinity;
  for (const r of rows) {
    const xi = xs.indexOf(Number(r.inputs[xKey]));
    const yi = ys.indexOf(Number(r.inputs[yKey]));
    if (xi < 0 || yi < 0 || !Number.isFinite(r.score)) continue;
    const row = cells[yi]!;
    if (Number.isNaN(row[xi]!) || r.score > row[xi]!) row[xi] = r.score;
  }
  for (const row of cells)
    for (const v of row)
      if (!Number.isNaN(v)) {
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
  return { xKey, yKey, xs, ys, cells, min, max };
}

// ------------------------------------------------------------------ walk-forward

export interface WalkForwardOptions {
  /** Number of consecutive folds (≥ 1). */
  folds: number;
  /** In-sample share of each fold (0.5..0.9). */
  inSample: number;
}

export interface FoldWindow {
  isFrom: number;
  isTo: number;
  oosFrom: number;
  oosTo: number;
}

/** Splits [start, end] into `folds` consecutive in-sample / out-of-sample windows. */
export function walkForwardWindows(
  start: number,
  end: number,
  o: WalkForwardOptions,
): FoldWindow[] {
  const folds = Math.max(1, Math.min(20, Math.round(o.folds)));
  const share = Math.min(0.9, Math.max(0.5, o.inSample));
  const span = (end - start) / folds;
  const out: FoldWindow[] = [];
  for (let k = 0; k < folds; k++) {
    const a = start + k * span;
    const b = k === folds - 1 ? end : start + (k + 1) * span;
    const m = a + (b - a) * share;
    out.push({ isFrom: a, isTo: m, oosFrom: m, oosTo: b });
  }
  return out;
}

export interface FoldResult extends FoldWindow {
  best: RawInputs | null;
  isScore: number;
  oos: BacktestResult | null;
}

/**
 * Walk-forward analysis: per fold, optimise on the in-sample window, then trade the best inputs
 * on the following out-of-sample window. Every run sees the data from the start (indicator
 * warm-up) but may only trade inside its window.
 */
export class WalkForward {
  readonly windows: FoldWindow[];
  readonly folds: FoldResult[] = [];
  private grid: RawInputs[];
  private opt: Optimizer | null = null;
  private oos: Backtest | null = null;

  constructor(
    readonly def: AnyStrategy,
    base: RawInputs,
    ranges: ParamRange[],
    readonly data: BacktestData,
    readonly config: BacktestConfig,
    readonly objective: Objective,
    opts: WalkForwardOptions,
  ) {
    const first = data.trades[0]?.ts ?? data.start;
    const last = data.trades[data.trades.length - 1]?.ts ?? data.end;
    this.windows = walkForwardWindows(first, last + 1, opts);
    this.grid = buildGrid(def.inputs, base, ranges);
  }

  get done(): boolean {
    return this.folds.length >= this.windows.length;
  }

  progress(): number {
    const per = 1 / Math.max(1, this.windows.length);
    const inner = this.opt
      ? this.opt.progress() * 0.9
      : this.oos
        ? 0.9 + this.oos.progress() * 0.1
        : 0;
    return Math.min(1, this.folds.length * per + inner * per);
  }

  step(budgetMs = Infinity): boolean {
    const t0 = performance.now();
    while (!this.done) {
      const w = this.windows[this.folds.length]!;
      const left = () => Math.max(1, budgetMs - (performance.now() - t0));
      if (!this.oos) {
        if (!this.opt)
          this.opt = new Optimizer(
            this.def,
            {},
            [],
            this.data,
            { ...this.config, window: { from: w.isFrom, to: w.isTo } },
            this.objective,
            this.grid,
          );
        if (!this.opt.step(left())) return false;
        const best = this.opt.best();
        this.opt = null;
        if (!best || !Number.isFinite(best.score)) {
          this.folds.push({ ...w, best: null, isScore: Number.NaN, oos: null });
          continue;
        }
        this.oos = new Backtest(this.def, best.inputs, this.data, {
          ...this.config,
          window: { from: w.oosFrom, to: w.oosTo },
        });
        this.pendingBest = best;
      }
      if (!this.oos.step(left())) return false;
      this.folds.push({
        ...w,
        best: this.pendingBest!.inputs,
        isScore: this.pendingBest!.score,
        oos: this.oos.result(),
      });
      this.oos = null;
      this.pendingBest = null;
      if (performance.now() - t0 > budgetMs) return this.done;
    }
    return true;
  }

  private pendingBest: OptimizeRow | null = null;

  /** Out-of-sample totals over every fold. */
  summary(): { trades: number; netPnl: number; winRate: number; profitableFolds: number } {
    let trades = 0;
    let net = 0;
    let wins = 0;
    let good = 0;
    for (const f of this.folds) {
      if (!f.oos) continue;
      trades += f.oos.stats.trades;
      net += f.oos.stats.netPnl;
      wins += f.oos.stats.wins;
      if (f.oos.stats.netPnl > 0) good++;
    }
    return { trades, netPnl: net, winRate: trades ? wins / trades : 0, profitableFolds: good };
  }
}
