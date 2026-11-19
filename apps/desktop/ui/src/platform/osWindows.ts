/**
 * Separate OS windows — main-window side (P02 / P25 / P44). Keeps the registry of open OS windows,
 * opens / closes them through the Rust commands (`os_window_*`), answers their `hello`, applies the
 * changes they send, and forwards window-state, settings, paper-account and store changes to them.
 *
 * In the web build there is no second native window: every entry point returns `false` (or folds
 * the windows back into floating dock windows) and callers use the in-app floating window.
 */
import { create } from 'zustand';
import { toast } from '@htflow/ui-kit';
import type { WindowState } from '@htflow/workspace';
import { isTauri, native, onNative } from './native';
import { listenBus, sendBus } from './busTransport';
import {
  MAIN_LABEL,
  detachedIds,
  diffValues,
  diffWindows,
  isPaperMethod,
  newWindowLabel,
  ownerOf,
  reduceRegistry,
  type BusMsg,
  type OsWindowEntry,
  type PaperAccountSnap,
  type Registry,
  type RegistryAction,
} from './windowBus';
import { useWindows } from '../state/windows';
import { getSetting, getSettings, setSettings, useSettingsStore } from '../state/settings';
import { useSession } from '../state/session';
import { paper } from '../state/market';
import { reloadPersisted, setPersistedSaveHook } from '../trading/persist';
import { log } from '../state/log';

import { translateLiteral as tl } from '@htflow/i18n';
/** Stores only the main window writes; a secondary window never saves or reloads them. */
export const MAIN_OWNED_KEYS = new Set([
  'settings',
  'workspace',
  'workspaces.library',
  'trading.accounts',
]);
const CLOSED_EVENT = 'htflow:os-window-closed';

/** What the Dashboard (owner of dockview) does for the OS windows. */
export interface OsDockHost {
  /** Ids of the windows in the same dock group as `id` (detach moves the whole group). */
  groupOf(id: string): string[];
  /** Removes dock panels but keeps their window states. */
  takePanels(ids: string[]): void;
  /** Adds panels for existing window states back into the dock. */
  putPanels(ids: string[], o: { floating: boolean }): void;
  titleOf(id: string): string;
  newId(kind: string): string;
  /** The registry changed: save the workspace. */
  requestSave(): void;
}

export const useOsWindows = create<{ reg: Registry }>(() => ({ reg: {} }));

let host: OsDockHost | null = null;
let suspended = false;

const reg = () => useOsWindows.getState().reg;

function dispatch(a: RegistryAction): void {
  const prev = reg();
  const next = reduceRegistry(prev, a);
  if (next === prev) return;
  useOsWindows.setState({ reg: next });
  host?.requestSave();
}

/** Separate OS windows exist only in the desktop app. */
export const osWindowsAvailable = (): boolean => isTauri;

/** "Detach window" target from Settings → Layout → Detach window opens. */
export const detachUsesOsWindow = (): boolean =>
  getSetting('layout.detachMode') === 'os' && osWindowsAvailable();

export function osEntries(): OsWindowEntry[] {
  return Object.values(reg());
}

export function isDetached(id: string): boolean {
  return ownerOf(reg(), id) !== null;
}

export function osWindowOf(id: string): string | null {
  return ownerOf(reg(), id);
}

function sizeOfNew(): { width: number; height: number } {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  return {
    width: Math.round(Math.max(getSetting('layout.newWindowWidth'), 480) * dpr),
    height: Math.round(Math.max(getSetting('layout.newWindowHeight'), 320) * dpr),
  };
}

async function openNative(e: OsWindowEntry): Promise<void> {
  try {
    await native('os_window_open', { req: { label: e.label, title: e.title, ...sizeOfNew() } });
  } catch (err) {
    log.error('windows', `Opening an OS window failed: ${String(err)}`);
    toast('error', tl('Could not open a new window'), String(err));
    reattach(e.label);
  }
}

function closeNative(label: string): void {
  sendBus({ t: 'close', from: MAIN_LABEL, to: label });
  void native('os_window_close', { label }).catch(() => {});
}

function openEntry(entry: OsWindowEntry): void {
  dispatch({ type: 'open', entry });
  void openNative(entry);
}

/** Moves the dock group of window `id` into a new OS window. False when not possible. */
export function detachToOsWindow(id: string): boolean {
  if (!osWindowsAvailable() || !host) return false;
  const existing = osWindowOf(id);
  if (existing) {
    void native('os_window_focus', { label: existing }).catch(() => {});
    return true;
  }
  const ids = host.groupOf(id).filter((x) => x in useWindows.getState().windows);
  if (!ids.length) return false;
  const entry: OsWindowEntry = {
    label: newWindowLabel(),
    title: host.titleOf(ids.includes(id) ? id : ids[0]!),
    kind: 'panels',
    ids,
  };
  dispatch({ type: 'open', entry });
  host.takePanels(ids);
  void openNative(entry);
  return true;
}

/** Opens a new window state straight into its own OS window (Clone / Create linked …). */
export function openStateInOsWindow(state: WindowState): boolean {
  if (!osWindowsAvailable() || !host) return false;
  const id = host.newId(state.kind);
  useWindows.getState().add(id, state);
  openEntry({ label: newWindowLabel(), title: host.titleOf(id), kind: 'panels', ids: [id] });
  return true;
}

/**
 * Opens a layout tab of a saved workspace in its own OS window. The windows get new ids (the same
 * workspace may be loaded in the main window too); their states join the main window's store.
 */
export function openTabInOsWindow(
  name: string,
  tab: { layout: unknown; windows: Record<string, WindowState>; specs?: unknown },
  workspaceId?: string,
  remap?: (
    layout: unknown,
    windows: Record<string, WindowState>,
    newId: (old: string) => string,
  ) => { layout: unknown; windows: Record<string, WindowState> },
): boolean {
  if (!osWindowsAvailable() || !host) return false;
  const h = host;
  const src = tab.layout ?? (tab.specs ? { specs: tab.specs } : null);
  const r = remap
    ? remap(src, tab.windows, (old) => h.newId(tab.windows[old]?.kind ?? 'win'))
    : { layout: src, windows: tab.windows };
  const ids = Object.keys(r.windows);
  if (!ids.length) return false;
  for (const [id, w] of Object.entries(r.windows)) useWindows.getState().add(id, w);
  openEntry({
    label: newWindowLabel(),
    title: name,
    kind: 'workspace',
    ids,
    ...(r.layout ? { layout: r.layout } : {}),
    ...(workspaceId ? { workspaceId } : {}),
  });
  return true;
}

/** Puts the windows of an OS window back into the main dock and closes it. */
export function reattach(label: string): void {
  const e = reg()[label];
  if (!e) return;
  dispatch({ type: 'closed', label });
  host?.putPanels(
    e.ids.filter((id) => id in useWindows.getState().windows),
    { floating: false },
  );
  closeNative(label);
}

/** Re-attaches every OS window (Command Palette). */
export function reattachAll(): number {
  const labels = Object.keys(reg());
  labels.forEach(reattach);
  return labels.length;
}

/** Re-attaches the OS window that shows window `id`. */
export function reattachWindow(id: string): boolean {
  const l = osWindowOf(id);
  if (!l) return false;
  reattach(l);
  return true;
}

export function focusOsWindowOf(id: string): boolean {
  const l = osWindowOf(id);
  if (!l) return false;
  void native('os_window_focus', { label: l }).catch(() => {});
  return true;
}

/**
 * Shows the OS windows of a layout tab (start-up, tab switch, workspace load). Windows already
 * open with the same label are re-initialised in place; the others are closed. In the web build
 * the windows become floating dock windows.
 */
export function applyOsWindows(entries: OsWindowEntry[]): void {
  const before = suspended ? {} : reg();
  suspended = false;
  const keep = new Set(entries.map((e) => e.label));
  for (const l of Object.keys(before)) if (!keep.has(l)) closeNative(l);
  if (!osWindowsAvailable()) {
    useOsWindows.setState({ reg: {} });
    for (const e of entries) host?.putPanels(e.ids, { floating: true });
    return;
  }
  useOsWindows.setState({ reg: reduceRegistry({}, { type: 'reset', entries }) });
  for (const e of Object.values(reg())) {
    if (before[e.label]) sendInit(e.label);
    else void openNative(e);
  }
}

/** The main window goes away (lock, sign-out): close OS windows, keep what was saved. */
export function suspendOsWindows(): void {
  if (suspended) return;
  suspended = true;
  for (const l of Object.keys(reg())) closeNative(l);
}

// ------------------------------------------------------------------ bus (main side)

export function paperSnapshot(): PaperAccountSnap[] {
  return [...paper.accounts.values()]
    .filter((a) => a.kind === 'paper')
    .map((a) => ({
      id: a.id,
      name: a.name,
      currency: a.currency,
      startingBalance: a.startingBalance,
      balance: a.balance,
      locked: a.locked,
      state: paper.exportAccountState(a.id),
    }));
}

function sendInit(label: string): void {
  const e = reg()[label];
  const session = useSession.getState().session;
  if (!e || !session) {
    sendBus({ t: 'close', from: MAIN_LABEL, to: label });
    return;
  }
  const all = useWindows.getState().windows;
  const windows: Record<string, WindowState> = {};
  for (const id of e.ids) if (all[id]) windows[id] = all[id]!;
  sendBus({
    t: 'init',
    from: MAIN_LABEL,
    to: label,
    session,
    entry: e,
    windows,
    settings: { ...getSettings() },
    paper: paperSnapshot(),
  });
}

/** Runs a trading action a secondary window asked for. */
function runPaper(method: string, args: unknown[]): void {
  if (!isPaperMethod(method)) return;
  const fn = (paper as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
  try {
    fn?.apply(paper, args);
  } catch (e) {
    log.error('windows', `Trading action from another window failed: ${String(e)}`);
  }
}

function onMessage(m: BusMsg): void {
  if (m.from === MAIN_LABEL) return;
  const entry = reg()[m.from];
  switch (m.t) {
    case 'hello':
      if (entry && !suspended) sendInit(m.from);
      else sendBus({ t: 'close', from: MAIN_LABEL, to: m.from });
      return;
    case 'windows': {
      if (!entry) return;
      const st = useWindows.getState();
      for (const [id, w] of Object.entries(m.windows)) {
        if (!entry.ids.includes(id)) continue;
        const cur = st.windows[id];
        // Only the changed fields, so link groups follow a real instrument change only.
        if (cur)
          st.patch(
            id,
            diffValues(
              cur as unknown as Record<string, unknown>,
              w as unknown as Record<string, unknown>,
            ) as Partial<WindowState>,
          );
        else st.add(id, w);
      }
      const removed = (m.removed ?? []).filter((id) => entry.ids.includes(id));
      if (removed.length) {
        for (const id of removed) useWindows.getState().remove(id);
        dispatch({ type: 'remove-windows', ids: removed });
        if (!reg()[m.from]) closeNative(m.from);
      }
      return;
    }
    case 'layout':
      if (entry) dispatch({ type: 'layout', label: m.from, layout: m.layout, title: m.title });
      return;
    case 'settings':
      if (entry) setSettings(m.values as Parameters<typeof setSettings>[0]);
      return;
    case 'paper.call':
      if (entry) runPaper(m.method, m.args);
      return;
    case 'store.saved':
      if (!MAIN_OWNED_KEYS.has(m.key)) reloadPersisted(m.key);
      return;
    case 'reattach':
      reattach(m.from);
      return;
    default:
      return;
  }
}

let installed = false;

/** Called by the Dashboard once its dock is ready (idempotent; the host is replaced). */
export function installOsWindowsMain(h: OsDockHost): void {
  host = h;
  if (installed || !isTauri) return;
  installed = true;
  void listenBus(onMessage);
  void onNative<string>(CLOSED_EVENT, (label) => {
    // Closed with Alt+F4 / the taskbar: its windows come back into the main window.
    if (!suspended && reg()[label]) reattach(label);
  });

  // Window states: forward changes of detached windows; drop windows closed in the main window.
  let last = useWindows.getState().windows;
  useWindows.subscribe((s) => {
    const prev = last;
    last = s.windows;
    const r = reg();
    if (!Object.keys(r).length || suspended) return;
    const ids = detachedIds(r);
    const d = diffWindows(prev, s.windows, ids);
    if (d.removed.length) {
      const lost = d.removed.filter((id) => !(id in s.windows));
      dispatch({ type: 'remove-windows', ids: lost });
      for (const l of Object.keys(r)) if (!reg()[l]) closeNative(l);
    }
    if (Object.keys(d.changed).length || d.removed.length)
      sendBus({ t: 'windows', from: MAIN_LABEL, windows: d.changed, removed: d.removed });
  });

  // Settings (theme included): every change goes to the OS windows.
  useSettingsStore.subscribe((s, p) => {
    if (!Object.keys(reg()).length || suspended || s.values === p.values) return;
    const values = diffValues(
      p.values as unknown as Record<string, unknown>,
      s.values as unknown as Record<string, unknown>,
    );
    if (Object.keys(values).length) sendBus({ t: 'settings', from: MAIN_LABEL, values });
  });

  // Orders / positions: the paper engine runs here; OS windows get snapshots.
  let timer: ReturnType<typeof setTimeout> | null = null;
  paper.subscribe(() => {
    if (!Object.keys(reg()).length || suspended || timer) return;
    timer = setTimeout(() => {
      timer = null;
      sendBus({ t: 'paper.state', from: MAIN_LABEL, accounts: paperSnapshot() });
    }, 100);
  });

  setPersistedSaveHook((key) => sendBus({ t: 'store.saved', from: MAIN_LABEL, key }));
}
