import { create } from 'zustand';
import { normalizeExt, type IndicatorConfig, type IndicatorsExt } from '@htflow/indicator-sdk';
import { indicatorById } from '@htflow/indicators';
import type { WindowState } from '@htflow/workspace';
import { useWindows } from '../../state/windows';
import type { ChartExtensionContext } from '../../charts/extensions';

export const EXT_ID = 'indicators';

/** Live extension contexts per chart window (set in attach). */
export const contexts = new Map<string, ChartExtensionContext>();

export function readExt(windowId: string): IndicatorsExt {
  const w = useWindows.getState().windows[windowId];
  return normalizeExt(w?.kind === 'chart' ? w.ext?.[EXT_ID] : undefined, indicatorById);
}

/** Persists the indicator list into ChartWindowState.ext.indicators (saved with the workspace). */
export function writeExt(windowId: string, items: IndicatorConfig[]): void {
  const value: IndicatorsExt = { v: 1, items };
  const ctx = contexts.get(windowId);
  if (ctx) {
    ctx.setExt(value);
    return;
  }
  const cur = useWindows.getState().windows[windowId];
  if (cur?.kind !== 'chart') return;
  useWindows.getState().patch(windowId, { ext: { ...(cur.ext ?? {}), [EXT_ID]: value } } as Partial<WindowState>);
}

interface DialogState {
  windowId: string | null;
  select: string | null;
  open(windowId: string, select?: string | null): void;
  close(): void;
}

export const useIndicatorDialog = create<DialogState>((set) => ({
  windowId: null,
  select: null,
  open: (windowId, select = null) => set({ windowId, select }),
  close: () => set({ windowId: null, select: null }),
}));

/** The chart window commands act on: the active one, else the first chart. */
export function targetChart(): string | null {
  const { windows, activeId } = useWindows.getState();
  if (activeId && windows[activeId]?.kind === 'chart') return activeId;
  return Object.entries(windows).find(([, w]) => w.kind === 'chart')?.[0] ?? null;
}
