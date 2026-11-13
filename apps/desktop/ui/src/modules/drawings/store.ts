import { create } from 'zustand';
import type { ChartCore } from '@htflow/chart-engine';
import { t } from '@htflow/i18n';
import {
  deserialize,
  isTool,
  serialize,
  toolDef,
  type Drawing,
  type DrawingController,
  type ToolId,
} from '@htflow/drawings';
import type { ChartWindowState, WindowState } from '@htflow/workspace';
import { toast } from '@htflow/ui-kit';
import { backend } from '../../backend';
import { useWindows } from '../../state/windows';
import { readExt, writeExt as writeIndicators } from '../indicators/state';
import type { ChartExtensionContext } from '../../charts/extensions';

export const EXT_ID = 'drawings';

export interface DrawPrefs {
  /** Stay in the tool after placing a drawing. */
  keep: boolean;
  magnet: boolean;
  /** Magnet sensitivity in px (2..40). */
  magnetPx: number;
  snapTicks: boolean;
  /** Show the selected-drawing style toolbar. */
  toolbar: boolean;
  /** Magnifier zoom factor (1.5..8) and lens diameter in px (60..300). */
  lensZoom: number;
  lensSize: number;
}

export const DEFAULT_PREFS: DrawPrefs = {
  keep: false,
  magnet: true,
  magnetPx: 8,
  snapTicks: true,
  toolbar: true,
  lensZoom: 3,
  lensSize: 140,
};

interface DrawUi {
  tool: Record<string, ToolId | null>;
  /** Primary selected drawing per window (last of the multi-selection). */
  selected: Record<string, string | null>;
  /** Whole multi-selection per window (Shift+click / Ctrl+drag box). */
  multi: Record<string, string[]>;
  /** Magnifier lens on / off per window. */
  lens: Record<string, boolean>;
  /** Drawing preferences dialog. */
  prefsOpen: boolean;
  /** Properties dialog target. */
  editing: { windowId: string; id: string } | null;
  prefs: DrawPrefs;
  setTool(windowId: string, tool: ToolId | null): void;
  select(windowId: string, id: string | null): void;
  selectMany(windowId: string, ids: string[]): void;
  setLens(windowId: string, on: boolean): void;
  openPrefs(open: boolean): void;
  edit(target: { windowId: string; id: string } | null): void;
  setPrefs(p: Partial<DrawPrefs>): void;
  /** Applies loaded prefs (validated) without saving. */
  setPrefsSilent(p: DrawPrefs): void;
}

const PREFS_KEY = 'drawings.prefs';

export const useDrawUi = create<DrawUi>((set, get) => ({
  tool: {},
  selected: {},
  multi: {},
  lens: {},
  prefsOpen: false,
  editing: null,
  prefs: DEFAULT_PREFS,
  setTool: (windowId, tool) => {
    set({ tool: { ...get().tool, [windowId]: tool } });
    controllers.get(windowId)?.ctrl.cancel();
  },
  select: (windowId, id) => {
    const cur = get().multi[windowId] ?? [];
    if (get().selected[windowId] === id && cur.length === (id ? 1 : 0)) return;
    set({
      selected: { ...get().selected, [windowId]: id },
      multi: { ...get().multi, [windowId]: id ? [id] : [] },
    });
    invalidateAll(windowId);
  },
  selectMany: (windowId, ids) => {
    const uniq = [...new Set(ids)];
    set({
      selected: { ...get().selected, [windowId]: uniq[uniq.length - 1] ?? null },
      multi: { ...get().multi, [windowId]: uniq },
    });
    invalidateAll(windowId);
  },
  setLens: (windowId, on) => {
    set({ lens: { ...get().lens, [windowId]: on } });
    invalidateAll(windowId);
  },
  openPrefs: (prefsOpen) => set({ prefsOpen }),
  edit: (editing) => set({ editing }),
  setPrefsSilent: (p) => {
    const prefs = { ...p };
    prefs.magnetPx = Math.min(40, Math.max(2, Math.round(Number(prefs.magnetPx) || 8)));
    prefs.lensZoom = Math.min(8, Math.max(1.5, Number(prefs.lensZoom) || 3));
    prefs.lensSize = Math.min(300, Math.max(60, Math.round(Number(prefs.lensSize) || 140)));
    set({ prefs });
  },
  setPrefs: (p) => {
    const prefs = { ...get().prefs, ...p };
    prefs.magnetPx = Math.min(40, Math.max(2, Math.round(prefs.magnetPx)));
    prefs.lensZoom = Math.min(8, Math.max(1.5, Number(prefs.lensZoom) || 3));
    prefs.lensSize = Math.min(300, Math.max(60, Math.round(Number(prefs.lensSize) || 140)));
    set({ prefs });
    void backend.saveSettings(PREFS_KEY, prefs).catch(() => {});
  },
}));

function invalidateAll(windowId: string): void {
  const e = controllers.get(windowId);
  if (!e) return;
  for (const c of e.ctx.cores) c.invalidate();
}

let prefsLoaded = false;
export function loadPrefs(): void {
  if (prefsLoaded) return;
  prefsLoaded = true;
  backend
    .loadSettings<Partial<DrawPrefs>>(PREFS_KEY)
    .then((p) => {
      if (p && typeof p === 'object')
        useDrawUi.getState().setPrefsSilent({ ...DEFAULT_PREFS, ...p });
    })
    .catch(() => {
      prefsLoaded = false;
    });
}

/** windowId → controller + extension context of the chart currently built for that window. */
export const controllers = new Map<
  string,
  {
    ctrl: DrawingController;
    ctx: ChartExtensionContext;
    /** One controller per extra chart pane (Order Flow right pane), sharing the undo history. */
    extra: { ctrl: DrawingController; core: ChartCore }[];
  }
>();

const parsed = new WeakMap<object, Drawing[]>();

function chartState(windowId: string): ChartWindowState | null {
  const w = useWindows.getState().windows[windowId];
  return w?.kind === 'chart' ? w : null;
}

/** Drawings of a chart window (validated once per stored value). */
export function readDrawings(windowId: string): Drawing[] {
  const raw = chartState(windowId)?.ext?.[EXT_ID];
  if (!raw || typeof raw !== 'object') return [];
  let list = parsed.get(raw);
  if (!list) parsed.set(raw, (list = deserialize(raw, isTool)));
  return list;
}

function write(windowId: string, items: Drawing[]): void {
  const cur = chartState(windowId);
  if (!cur) return;
  const doc = serialize(items);
  parsed.set(doc, doc.items);
  const entry = controllers.get(windowId);
  if (entry) entry.ctx.setExt(doc);
  else
    useWindows
      .getState()
      .patch(windowId, { ext: { ...(cur.ext ?? {}), [EXT_ID]: doc } } as Partial<WindowState>);
}

/** Persists drawings and mirrors "sync" drawings to every chart of the same instrument. */
export function saveDrawings(windowId: string, next: Drawing[]): void {
  const prev = readDrawings(windowId);
  const me = chartState(windowId);
  write(windowId, next);
  if (!me) return;
  const synced = next.filter((d) => d.sync);
  const gone = new Set(
    prev.filter((d) => d.sync && !synced.some((n) => n.id === d.id)).map((d) => d.id),
  );
  if (!synced.length && !gone.size) return;
  for (const [id, w] of Object.entries(useWindows.getState().windows)) {
    if (id === windowId || w.kind !== 'chart' || w.instrumentId !== me.instrumentId) continue;
    const theirs = readDrawings(id).filter(
      (d) => !gone.has(d.id) && !synced.some((n) => n.id === d.id),
    );
    write(id, [...theirs, ...synced]);
    controllers.get(id)?.ctx.core.invalidate();
  }
}

/** The chart window hotkeys act on: the active window, or the first chart. */
export function activeChartId(): string | null {
  const { activeId, windows } = useWindows.getState();
  if (activeId && windows[activeId]?.kind === 'chart') return activeId;
  return Object.keys(windows).find((k) => windows[k]!.kind === 'chart') ?? null;
}

export function activateTool(tool: ToolId | null, windowId = activeChartId()): void {
  if (!windowId) return;
  const def = tool ? toolDef(tool) : null;
  if (tool && !def?.ready) {
    toast('info', t('drawings.notAvailable', { name: def?.label ?? tool }), def?.note);
    return;
  }
  const ui = useDrawUi.getState();
  if (tool && def?.command) {
    runToolCommand(tool, windowId);
    return;
  }
  ui.setTool(windowId, ui.tool[windowId] === tool ? null : tool);
  controllers.get(windowId)?.ctx.core.canvas.focus();
}

/** Applies a change through the window's controller (undo history) when a chart is mounted. */
export function mutate(windowId: string, fn: (items: Drawing[]) => Drawing[]): void {
  const entry = controllers.get(windowId);
  const next = fn(readDrawings(windowId));
  if (entry) entry.ctrl.commit(next);
  else saveDrawings(windowId, next);
}

export function openObjectsList(): void {
  window.dispatchEvent(new CustomEvent('htflow:open-module', { detail: 'drawing-objects' }));
}

/** Tools that are actions, not drawings. */
export function runToolCommand(tool: ToolId, windowId = activeChartId()): void {
  if (!windowId) return;
  const ui = useDrawUi.getState();
  if (tool === 'magnifier') {
    const on = !ui.lens[windowId];
    ui.setLens(windowId, on);
    toast(
      'info',
      on ? t('drawings.magnifierOnToast') : t('drawings.magnifierOff'),
      on ? t('drawings.pressM') : undefined,
    );
  } else if (tool === 'remove-indicators') {
    const n = readExt(windowId).items.length;
    if (!n) {
      toast('info', t('drawings.noIndicators'));
      return;
    }
    writeIndicators(windowId, []);
    toast('success', t('drawings.removedIndicators', { n, s: n === 1 ? '' : 's' }));
  }
}

/** Multi-selection of a window (ids), falling back to the single selected drawing. */
export function selectionOf(windowId: string): string[] {
  const ui = useDrawUi.getState();
  const m = ui.multi[windowId];
  if (m && m.length) return m;
  const one = ui.selected[windowId];
  return one ? [one] : [];
}

/** Applies a change to every selected drawing as a single undo step. */
export function mutateSelection(windowId: string, fn: (d: Drawing) => Drawing): void {
  const ids = new Set(selectionOf(windowId));
  if (!ids.size) return;
  mutate(windowId, (items) => items.map((d) => (ids.has(d.id) ? fn(d) : d)));
}
