/** Cross-chart buses: crosshair sync (P08 Sync / Global crosshair) and chart actions (menu, hotkeys). */
import type { CrosshairPoint } from '@htflow/chart-engine';
import type { LinkColor } from '@htflow/workspace';
import { useWindows } from '../state/windows';

export type CrosshairSync = 'off' | 'link' | 'global';

interface CrosshairSub {
  windowId: string;
  fn(pt: CrosshairPoint | null, sameInstrument: boolean): void;
  link(): LinkColor;
  instrumentId(): string;
}

const subs = new Set<CrosshairSub>();

export function subscribeCrosshair(sub: CrosshairSub): () => void {
  subs.add(sub);
  return () => subs.delete(sub);
}

/** Should a crosshair from `from` (sync mode `mode`) show on a chart in link group `to`? */
export function crosshairReaches(
  mode: CrosshairSync,
  fromLink: LinkColor,
  toLink: LinkColor,
): boolean {
  if (mode === 'global') return true;
  if (mode === 'link') return fromLink !== 'none' && fromLink === toLink;
  return false;
}

/** Broadcasts a chart's crosshair to other charts per its sync mode. */
export function publishCrosshair(
  windowId: string,
  mode: CrosshairSync,
  link: LinkColor,
  instrumentId: string,
  pt: CrosshairPoint | null,
): void {
  if (mode === 'off') return;
  for (const s of subs) {
    if (s.windowId === windowId) continue;
    if (!crosshairReaches(mode, link, s.link())) continue;
    s.fn(pt, s.instrumentId() === instrumentId);
  }
}

// ------------------------------------------------------------------ chart actions

export type ChartAction =
  | 'goto-date'
  | 'change-instrument'
  | 'overlay'
  | 'clear-overlays'
  | 'save-template'
  | 'refresh'
  | 'reload-history'
  | 'load-older'
  | 'export-png'
  | 'export-csv'
  | 'export-clusters'
  | 'export-json'
  | 'export-template'
  | 'fullscreen'
  | 'clone'
  | 'reset'
  /** Newest bar back at the right margin, following new bars (keeps the price scale). */
  | 'go-latest';

const actionSubs = new Map<string, (a: ChartAction, arg?: unknown) => void>();

export function onChartAction(
  windowId: string,
  fn: (a: ChartAction, arg?: unknown) => void,
): () => void {
  actionSubs.set(windowId, fn);
  return () => {
    if (actionSubs.get(windowId) === fn) actionSubs.delete(windowId);
  };
}

/** The active chart window id (or the first chart). */
export function activeChartId(): string | null {
  const { activeId, windows } = useWindows.getState();
  if (activeId && windows[activeId]?.kind === 'chart') return activeId;
  return Object.keys(windows).find((k) => windows[k]!.kind === 'chart') ?? null;
}

export function chartAction(a: ChartAction, windowId = activeChartId(), arg?: unknown): void {
  if (!windowId) return;
  actionSubs.get(windowId)?.(a, arg);
}
