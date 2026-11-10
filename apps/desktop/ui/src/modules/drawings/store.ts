import { create } from 'zustand';
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
}

export const DEFAULT_PREFS: DrawPrefs = {
  keep: false,
  magnet: true,
  magnetPx: 8,
  snapTicks: true,
  toolbar: true,
};

interface DrawUi {
  tool: Record<string, ToolId | null>;
  selected: Record<string, string | null>;
  /** Properties dialog target. */
  editing: { windowId: string; id: string } | null;
  prefs: DrawPrefs;
  setTool(windowId: string, tool: ToolId | null): void;
  select(windowId: string, id: string | null): void;
  edit(target: { windowId: string; id: string } | null): void;
  setPrefs(p: Partial<DrawPrefs>): void;
}

const PREFS_KEY = 'drawings.prefs';

export const useDrawUi = create<DrawUi>((set, get) => ({
  tool: {},
  selected: {},
  editing: null,
  prefs: DEFAULT_PREFS,
  setTool: (windowId, tool) => {
    set({ tool: { ...get().tool, [windowId]: tool } });
    controllers.get(windowId)?.ctrl.cancel();
  },
  select: (windowId, id) => {
    if (get().selected[windowId] === id) return;
    set({ selected: { ...get().selected, [windowId]: id } });
    controllers.get(windowId)?.ctx.core.invalidate();
  },
  edit: (editing) => set({ editing }),
  setPrefs: (p) => {
    const prefs = { ...get().prefs, ...p };
    prefs.magnetPx = Math.min(40, Math.max(2, Math.round(prefs.magnetPx)));
    set({ prefs });
    void backend.saveSettings(PREFS_KEY, prefs).catch(() => {});
  },
}));

let prefsLoaded = false;
export function loadPrefs(): void {
  if (prefsLoaded) return;
  prefsLoaded = true;
  backend
    .loadSettings<Partial<DrawPrefs>>(PREFS_KEY)
    .then((p) => {
      if (p && typeof p === 'object') useDrawUi.setState({ prefs: { ...DEFAULT_PREFS, ...p } });
    })
    .catch(() => {
      prefsLoaded = false;
    });
}

/** windowId → controller + extension context of the chart currently built for that window. */
export const controllers = new Map<
  string,
  { ctrl: DrawingController; ctx: ChartExtensionContext }
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
    toast('info', `${def?.label ?? tool} is not available yet`, def?.note);
    return;
  }
  const ui = useDrawUi.getState();
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
