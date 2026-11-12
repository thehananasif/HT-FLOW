import type { ChartWindowState, WindowState } from '@htflow/workspace';
import { useWindows } from '../../state/windows';
import { globalChartDefaults } from './globals';
import {
  diffFromDefaults,
  normalizeSettings,
  ROW_BY_KEY,
  validateValue,
  type ChartSettings,
} from './schema';

/** Key in ChartWindowState.ext holding per-chart settings and chart-core state. */
export const SETTINGS_EXT = 'chart-settings';

export interface CompareItem {
  instrumentId: string;
  color: string;
}

export interface ChartExtState {
  /** Settings that differ from the defaults. */
  settings?: ChartSettings;
  /** User-dragged sub-pane heights by layer id. */
  panes?: Record<string, number>;
  /** Compare / overlay instruments. */
  compare?: CompareItem[];
  /** Pinned: keeps its instrument when the link group changes. */
  pinned?: boolean;
  /** Id of the user template last applied. */
  templateId?: string;
}

export function extState(s: ChartWindowState | undefined): ChartExtState {
  const raw = s?.ext?.[SETTINGS_EXT];
  return raw && typeof raw === 'object' ? (raw as ChartExtState) : {};
}

/** Full (normalised) settings of a chart window. */
export function chartSettings(s: ChartWindowState | undefined): ChartSettings {
  return normalizeSettings(extState(s).settings, baseSettings());
}

/** Schema defaults with the global Settings → Chart / Footprint defaults applied. */
export function baseSettings(): ChartSettings {
  return normalizeSettings(globalChartDefaults());
}

function chartWindow(id: string): ChartWindowState | undefined {
  const w = useWindows.getState().windows[id];
  return w?.kind === 'chart' ? w : undefined;
}

/** Merges into ext['chart-settings'] of a chart window (persisted with the workspace). */
export function patchChartExt(windowId: string, p: Partial<ChartExtState>): void {
  const cur = chartWindow(windowId);
  if (!cur) return;
  const next: ChartExtState = { ...extState(cur), ...p };
  useWindows
    .getState()
    .patch(windowId, { ext: { ...(cur.ext ?? {}), [SETTINGS_EXT]: next } } as Partial<WindowState>);
}

/** Replaces all settings of a chart (stores only the non-default keys). */
export function setChartSettings(windowId: string, s: ChartSettings): void {
  const base = baseSettings();
  patchChartExt(windowId, { settings: diffFromDefaults(normalizeSettings(s, base), base) });
}

/** Sets one validated setting; returns false for unknown keys or invalid values. */
export function setChartSetting(windowId: string, key: string, value: unknown): boolean {
  const row = ROW_BY_KEY.get(key);
  if (!row) return false;
  const v = validateValue(row, value);
  if (v === undefined) return false;
  const cur = chartWindow(windowId);
  if (!cur) return false;
  setChartSettings(windowId, { ...chartSettings(cur), [key]: v });
  return true;
}

/**
 * Read one chart setting of a window — for other modules (trading draws orders / positions with the
 * Trading Settings colours, drawings read magnet / selection settings).
 */
export function chartSettingFor(windowId: string, key: string): unknown {
  return chartSettings(chartWindow(windowId))[key];
}
