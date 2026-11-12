/**
 * Pure helpers of the Workspaces window: the "Manage workspace" tree and the workspace summary.
 */
import type { TreeNode } from '@htflow/ui-kit';
import {
  CHART_TEMPLATES,
  specsFromWindows,
  windowInstrument,
  type WindowState,
  type WorkspaceDoc,
} from '@htflow/workspace';

/** Items of a chart extension (`{ v, items: [...] }`, e.g. drawings, indicators). */
export function extItems(s: WindowState, extId: string): Record<string, unknown>[] {
  if (s.kind !== 'chart') return [];
  const e = s.ext?.[extId];
  if (!e || typeof e !== 'object') return [];
  const items = (e as { items?: unknown }).items;
  return Array.isArray(items)
    ? items.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    : [];
}

const titleCase = (s: string) =>
  s
    .replace(/[-_.]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());

/** Readable name of a drawing / indicator item. */
export function itemLabel(it: Record<string, unknown>): string {
  for (const k of ['label', 'name', 'type', 'indicator', 'id'])
    if (typeof it[k] === 'string' && it[k]) return titleCase(it[k] as string);
  return 'Object';
}

export interface WorkspaceSummary {
  layouts: number;
  windows: number;
  instruments: number;
  charts: number;
  doms: number;
  modules: number;
  heatmaps: number;
  drawings: number;
  indicators: number;
  templates: string[];
  /** Bytes of the saved workspace JSON. */
  bytes: number;
}

export function summarize(doc: WorkspaceDoc): WorkspaceSummary {
  const instruments = new Set<string>();
  const templates = new Set<string>();
  const s: WorkspaceSummary = {
    layouts: doc.tabs.length,
    windows: 0,
    instruments: 0,
    charts: 0,
    doms: 0,
    modules: 0,
    heatmaps: 0,
    drawings: 0,
    indicators: 0,
    templates: [],
    bytes: new Blob([JSON.stringify(doc)]).size,
  };
  for (const tab of doc.tabs)
    for (const w of Object.values(tab.windows)) {
      s.windows++;
      const i = windowInstrument(w);
      if (i) instruments.add(i);
      if (w.kind === 'chart') {
        s.charts++;
        if (w.template === 'liquidity-map') s.heatmaps++;
        templates.add(CHART_TEMPLATES.find((t) => t.id === w.template)?.short ?? w.template);
        s.drawings += extItems(w, 'drawings').length;
        s.indicators += extItems(w, 'indicators').length;
      } else if (w.kind === 'dom') s.doms++;
      else s.modules++;
    }
  s.instruments = instruments.size;
  s.templates = [...templates].sort();
  return s;
}

export interface ManageNodeInfo {
  kind: 'layout' | 'window' | 'objects' | 'object';
  tabId: string;
  windowId?: string;
  /** For windows: shown in the active layout right now. */
  open?: boolean;
  detail?: string;
}

/**
 * Tree of a workspace: layouts → windows (Opened / Closed) → Objects list (drawings, indicators).
 * `info` maps every node id to what it represents.
 */
export function manageTree(
  doc: WorkspaceDoc,
  title: (s: WindowState) => string,
  openIds: ReadonlySet<string>,
): { nodes: TreeNode[]; info: Map<string, ManageNodeInfo> } {
  const info = new Map<string, ManageNodeInfo>();
  const nodes = doc.tabs.map((tab, ti): TreeNode => {
    const tid = `t:${tab.id}`;
    const n = Object.keys(tab.windows).length;
    info.set(tid, { kind: 'layout', tabId: tab.id, detail: `Count: ${n}` });
    return {
      id: tid,
      label: `${tab.name} (layout ${ti + 1})`,
      children: Object.entries(tab.windows).map(([wid, w]): TreeNode => {
        const id = `w:${tab.id}:${wid}`;
        const open = tab.id === doc.activeTab && openIds.has(wid);
        const days =
          w.kind === 'chart' && typeof w.ext?.loadDays === 'number' ? w.ext.loadDays : null;
        info.set(id, {
          kind: 'window',
          tabId: tab.id,
          windowId: wid,
          open,
          detail: days !== null ? `Load days: ${days}` : open ? 'Opened' : 'Closed',
        });
        const objs = [
          ...extItems(w, 'drawings').map((it) => ({ it, src: 'Drawing' })),
          ...extItems(w, 'indicators').map((it) => ({ it, src: 'Indicator' })),
        ];
        if (!objs.length) return { id, label: title(w) };
        const oid = `o:${tab.id}:${wid}`;
        info.set(oid, {
          kind: 'objects',
          tabId: tab.id,
          windowId: wid,
          detail: `Count: ${objs.length}`,
        });
        return {
          id,
          label: title(w),
          children: [
            {
              id: oid,
              label: 'Objects list',
              children: objs.map(({ it, src }, k) => {
                const xid = `x:${tab.id}:${wid}:${k}`;
                info.set(xid, { kind: 'object', tabId: tab.id, windowId: wid, detail: src });
                return { id: xid, label: itemLabel(it) };
              }),
            },
          ],
        };
      }),
    };
  });
  return { nodes, info };
}

/** Removes a window from a saved (not loaded) workspace document. */
export function removeWindowFromDoc(
  doc: WorkspaceDoc,
  tabId: string,
  windowId: string,
): WorkspaceDoc {
  return {
    ...doc,
    tabs: doc.tabs.map((t) => {
      if (t.id !== tabId || !t.windows[windowId]) return t;
      const windows = { ...t.windows };
      delete windows[windowId];
      // The dockview layout no longer matches; rebuild from the remaining windows.
      return { ...t, windows, layout: null, specs: specsFromWindows(windows) };
    }),
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
