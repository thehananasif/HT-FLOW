import type { ToolId } from '@htflow/drawings';
import { useWindows } from '../../state/windows';
import type { ColumnMs, HeatmapModuleSettings } from './model';

/** What Command Palette entries can do to a Heatmap window. */
export interface HeatmapApi {
  patch(p: Partial<HeatmapModuleSettings>): void;
  settings(): HeatmapModuleSettings;
  toggle3d(): void;
  quickSettings(): void;
  fullSettings(): void;
  column(ms: ColumnMs): void;
  stress(): void;
  resetView(): void;
  resetSettings(): void;
  snapshot(): void;
  tool(t: ToolId | null): void;
  objects(): void;
}

const apis = new Map<string, HeatmapApi>();
let lastActive: string | null = null;

useWindows.subscribe((s) => {
  if (s.activeId && apis.has(s.activeId)) lastActive = s.activeId;
});

export function registerHeatmapApi(windowId: string, api: HeatmapApi): () => void {
  apis.set(windowId, api);
  return () => {
    if (apis.get(windowId) === api) apis.delete(windowId);
  };
}

/** The active Heatmap window, else the last one used, else any open one. */
export function targetHeatmap(): HeatmapApi | null {
  const active = useWindows.getState().activeId;
  if (active && apis.has(active)) return apis.get(active)!;
  if (lastActive && apis.has(lastActive)) return apis.get(lastActive)!;
  const first = apis.values().next();
  return first.done ? null : first.value;
}
