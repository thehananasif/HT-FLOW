import type { PlotPoint } from '@htflow/strategy';
import type { Bar } from '@htflow/market-data';

/**
 * Chart overlay for the `plot(name, value)` outputs of HT Editor strategies: while a paper run is
 * active, its overlay plots are drawn on every chart window of the run's instrument (see
 * `plotOverlayExt.ts`). The overlay can be switched off for all runs or per run.
 */

/** The parts of a run the overlay reads. */
export interface PlotRunLike {
  id: string;
  name: string;
  instrumentId: string;
  status: 'starting' | 'running' | 'stopped' | 'error';
  bridge: { plots: readonly PlotPoint[] } | null;
}

export interface PlotLine {
  runId: string;
  runName: string;
  name: string;
  color: string;
  points: { t: number; value: number }[];
}

export const PLOT_PALETTE = ['#4fc3f7', '#ffb74d', '#ab47bc', '#66bb6a', '#ef5350', '#ffd54f'];

interface OverlayState {
  /** Master switch (Command Palette: Show / hide strategy plots on charts). */
  enabled: boolean;
  hidden: ReadonlySet<string>;
  version: number;
}

let state: OverlayState = { enabled: true, hidden: new Set(), version: 0 };
const listeners = new Set<() => void>();
let queued = false;

function emit(): void {
  for (const l of listeners) l();
}

export const plotOverlay = {
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  state: (): OverlayState => state,
  version: (): number => state.version,
  isEnabled: (): boolean => state.enabled,
  isRunVisible: (runId: string): boolean => state.enabled && !state.hidden.has(runId),
  setEnabled(enabled: boolean): void {
    state = { ...state, enabled, version: state.version + 1 };
    emit();
  },
  /** Hides / shows the plots of one run on the charts. */
  setRunVisible(runId: string, visible: boolean): void {
    const hidden = new Set(state.hidden);
    if (visible) hidden.delete(runId);
    else hidden.add(runId);
    state = { ...state, hidden, version: state.version + 1 };
    emit();
  },
  /** New plot points arrived: charts redraw (coalesced to one notification per tick). */
  changed(): void {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      state = { ...state, version: state.version + 1 };
      emit();
    });
  },
  reset(): void {
    state = { enabled: true, hidden: new Set(), version: state.version + 1 };
    emit();
  },
};

/**
 * The lines to draw for one instrument: overlay plots of active runs on that instrument, grouped
 * by run and name, in time order. Stopped runs, other instruments and hidden runs yield nothing.
 */
export function plotLines(
  runs: readonly PlotRunLike[],
  instrumentId: string,
  visible: (runId: string) => boolean = plotOverlay.isRunVisible,
): PlotLine[] {
  const out: PlotLine[] = [];
  for (const run of runs) {
    if (run.instrumentId !== instrumentId || !run.bridge) continue;
    if (run.status !== 'running' && run.status !== 'starting') continue;
    if (!visible(run.id)) continue;
    const byName = new Map<string, PlotLine>();
    for (const p of run.bridge.plots) {
      if (!p.overlay) continue;
      let line = byName.get(p.name);
      if (!line) {
        line = {
          runId: run.id,
          runName: run.name,
          name: p.name,
          color: p.color ?? PLOT_PALETTE[byName.size % PLOT_PALETTE.length]!,
          points: [],
        };
        byName.set(p.name, line);
      }
      line.points.push({ t: p.t, value: p.value });
    }
    out.push(...byName.values());
  }
  return out;
}

/** Index of the last bar that opened at or before `t`, or -1. */
export function barIndexAt(bars: readonly Pick<Bar, 't'>[], t: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  if (hi < 0 || t < bars[0]!.t) return -1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (bars[m]!.t <= t) lo = m;
    else hi = m - 1;
  }
  return lo;
}

/**
 * Maps plot points to chart slots: the last value per bar slot wins (a script that plots on every
 * tick draws one point per bar), in slot order. Values are converted from price to ticks.
 */
export function plotSlots(
  bars: readonly Pick<Bar, 't'>[],
  points: readonly { t: number; value: number }[],
  tickSize: number,
): { i: number; ticks: number }[] {
  if (!(tickSize > 0)) return [];
  const bySlot = new Map<number, number>();
  for (const p of points) {
    const i = barIndexAt(bars, p.t);
    if (i >= 0) bySlot.set(i, p.value / tickSize);
  }
  return [...bySlot.entries()].sort((a, b) => a[0] - b[0]).map(([i, ticks]) => ({ i, ticks }));
}
