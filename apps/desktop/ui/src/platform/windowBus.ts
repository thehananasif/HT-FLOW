/**
 * Window bus (P02 / P25 / P44): typed messages between the main window and secondary OS windows,
 * and the pure reducers both sides run on them. Transport and side effects live in
 * `osWindows.ts` (main) and `secondary.ts` (secondary windows); everything here is pure and tested.
 *
 * Ownership (see docs/ARCHITECTURE.md → Separate OS windows):
 * - The main window owns every window state (the workspace), the settings file, the paper
 *   engine (orders / positions) and the registry of open OS windows.
 * - A secondary window renders the window states it was given, subscribes to market data itself
 *   (its own MarketHub — each window has its own JS context), and sends every local change back.
 */
import type { OsWindowSpec, WindowState } from '@htflow/workspace';
import type { SessionInfo } from '../backend';
import type { AccountState } from '@htflow/trading';

export const BUS_EVENT = 'htflow:bus';
export const MAIN_LABEL = 'main';
export const LABEL_PREFIX = 'ht-w-';
const LABEL_RE = /^ht-w-[a-z0-9-]+$/;

/** Mirrors `validate_label` in `src-tauri/src/os_windows.rs`. */
export function isSecondaryLabel(label: unknown): label is string {
  return typeof label === 'string' && label.length <= 48 && LABEL_RE.test(label);
}

let seq = 0;
export function newWindowLabel(now = Date.now(), rnd = Math.random()): string {
  return `${LABEL_PREFIX}${now.toString(36)}${(seq++).toString(36)}${Math.floor(rnd * 1296)
    .toString(36)
    .padStart(2, '0')}`;
}

/** `?window=<label>` of a secondary window (browser route; the desktop app also checks its label). */
export function secondaryLabelFromSearch(search: string): string | null {
  const v = new URLSearchParams(search).get('window');
  return isSecondaryLabel(v) ? v : null;
}

/** One open OS window, as the main window remembers it (saved with the layout tab). */
export type OsWindowEntry = OsWindowSpec;

/** Paper account snapshot sent from the main window (orders / positions / balance). */
export interface PaperAccountSnap {
  id: string;
  name: string;
  currency: string;
  startingBalance: number;
  balance: number;
  locked: boolean;
  state: AccountState;
}

export type BusMsg =
  /** secondary → main: "I am up, send me my windows". */
  | { t: 'hello'; from: string }
  /** main → one secondary: everything it needs to render. */
  | {
      t: 'init';
      from: string;
      to: string;
      session: SessionInfo;
      entry: OsWindowEntry;
      windows: Record<string, WindowState>;
      settings: Record<string, unknown>;
      paper: PaperAccountSnap[];
      activeAccount?: string;
    }
  /** Window states changed (upserts) / closed (`removed`). main → all, or secondary → main. */
  | { t: 'windows'; from: string; windows: Record<string, WindowState>; removed?: string[] }
  /** secondary → main: its dock layout changed (saved with the workspace). */
  | { t: 'layout'; from: string; layout: unknown; title?: string }
  /** Settings changed (only the changed keys). Any window → every other window. */
  | { t: 'settings'; from: string; values: Record<string, unknown> }
  /** secondary → main: a trading action (the main window's paper engine is the only one). */
  | { t: 'paper.call'; from: string; method: PaperMethod; args: unknown[] }
  /** main → all: paper accounts after a change. */
  | { t: 'paper.state'; from: string; accounts: PaperAccountSnap[]; activeAccount?: string }
  /** A per-profile store (`Persisted`) was saved; other windows reload it. */
  | { t: 'store.saved'; from: string; key: string }
  /** secondary → main: put my windows back into the main window and close me. */
  | { t: 'reattach'; from: string }
  /** main → secondary: you are being closed (layout tab switch, workspace load). */
  | { t: 'close'; from: string; to: string };

/** Paper engine methods a secondary window may ask the main window to run. */
export const PAPER_METHODS = [
  'place',
  'cancel',
  'modify',
  'cancelAll',
  'flatten',
  'flattenAll',
  'reverse',
  'breakeven',
  'linkOco',
  'unlinkOco',
  'tradeOption',
  'closeOption',
  'setLocked',
] as const;
export type PaperMethod = (typeof PAPER_METHODS)[number];

export function isPaperMethod(m: unknown): m is PaperMethod {
  return typeof m === 'string' && (PAPER_METHODS as readonly string[]).includes(m);
}

/** Runtime check of a message received over the event (anything malformed is dropped). */
export function parseBusMsg(raw: unknown): BusMsg | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.t !== 'string' || typeof m.from !== 'string') return null;
  if (m.from !== MAIN_LABEL && !isSecondaryLabel(m.from)) return null;
  const obj = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
  switch (m.t) {
    case 'hello':
    case 'reattach':
      return m as unknown as BusMsg;
    case 'init':
      return typeof m.to === 'string' && obj(m.entry) && obj(m.windows) && obj(m.session)
        ? (m as unknown as BusMsg)
        : null;
    case 'windows':
      return obj(m.windows) && (m.removed === undefined || Array.isArray(m.removed))
        ? (m as unknown as BusMsg)
        : null;
    case 'layout':
      return 'layout' in m ? (m as unknown as BusMsg) : null;
    case 'settings':
      return obj(m.values) ? (m as unknown as BusMsg) : null;
    case 'paper.call':
      return isPaperMethod(m.method) && Array.isArray(m.args) ? (m as unknown as BusMsg) : null;
    case 'paper.state':
      return Array.isArray(m.accounts) ? (m as unknown as BusMsg) : null;
    case 'store.saved':
      return typeof m.key === 'string' ? (m as unknown as BusMsg) : null;
    case 'close':
      return typeof m.to === 'string' ? (m as unknown as BusMsg) : null;
    default:
      return null;
  }
}

// ------------------------------------------------------------------ main: OS window registry

export type Registry = Record<string, OsWindowEntry>;

export type RegistryAction =
  | { type: 'open'; entry: OsWindowEntry }
  | { type: 'closed'; label: string }
  | { type: 'layout'; label: string; layout: unknown; title?: string }
  /** Windows closed inside an OS window (or moved back): they leave their entry. */
  | { type: 'remove-windows'; ids: string[] }
  | { type: 'reset'; entries: OsWindowEntry[] };

/** Registry of open OS windows kept by the main window. Entries left with no window are dropped. */
export function reduceRegistry(reg: Registry, a: RegistryAction): Registry {
  switch (a.type) {
    case 'open': {
      if (!isSecondaryLabel(a.entry.label)) return reg;
      // A window lives in one place only: drop its id from any other OS window.
      const ids = new Set(a.entry.ids);
      const next: Registry = {};
      for (const [l, e] of Object.entries(reg)) {
        if (l === a.entry.label) continue;
        const keep = e.ids.filter((id) => !ids.has(id));
        if (keep.length) next[l] = keep.length === e.ids.length ? e : { ...e, ids: keep };
      }
      next[a.entry.label] = { ...a.entry, ids: [...ids] };
      return next;
    }
    case 'closed': {
      if (!(a.label in reg)) return reg;
      const next = { ...reg };
      delete next[a.label];
      return next;
    }
    case 'layout': {
      const e = reg[a.label];
      if (!e) return reg;
      return { ...reg, [a.label]: { ...e, layout: a.layout, title: a.title ?? e.title } };
    }
    case 'remove-windows': {
      const ids = new Set(a.ids);
      let changed = false;
      const next: Registry = {};
      for (const [l, e] of Object.entries(reg)) {
        const keep = e.ids.filter((id) => !ids.has(id));
        if (keep.length !== e.ids.length) changed = true;
        if (keep.length) next[l] = keep.length === e.ids.length ? e : { ...e, ids: keep };
      }
      return changed ? next : reg;
    }
    case 'reset': {
      const next: Registry = {};
      for (const e of a.entries) if (isSecondaryLabel(e.label) && e.ids.length) next[e.label] = e;
      return next;
    }
  }
}

/** OS window that shows window `id`, if any. */
export function ownerOf(reg: Registry, id: string): string | null {
  for (const [l, e] of Object.entries(reg)) if (e.ids.includes(id)) return l;
  return null;
}

/** Every window id living in an OS window. */
export function detachedIds(reg: Registry): Set<string> {
  return new Set(Object.values(reg).flatMap((e) => e.ids));
}

/** Saved entries of a layout tab (JSON from disk), validated. */
export function sanitizeEntries(raw: unknown, windows: Record<string, unknown>): OsWindowEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: OsWindowEntry[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const e = r as Record<string, unknown>;
    if (!isSecondaryLabel(e.label) || seen.has(e.label)) continue;
    const ids = Array.isArray(e.ids)
      ? e.ids.filter((x): x is string => typeof x === 'string' && x in windows)
      : [];
    if (!ids.length) continue;
    seen.add(e.label);
    out.push({
      label: e.label,
      title: typeof e.title === 'string' ? e.title.slice(0, 120) : 'HT Flow',
      kind: e.kind === 'workspace' ? 'workspace' : 'panels',
      ids,
      ...(e.layout !== undefined ? { layout: e.layout } : {}),
      ...(typeof e.workspaceId === 'string' ? { workspaceId: e.workspaceId } : {}),
    });
  }
  return out;
}

// ------------------------------------------------------------------ window-state sync

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Changed / removed windows between two snapshots (deep compare, so echoes are not resent). */
export function diffWindows(
  prev: Record<string, WindowState>,
  next: Record<string, WindowState>,
  only?: ReadonlySet<string>,
): { changed: Record<string, WindowState>; removed: string[] } {
  const changed: Record<string, WindowState> = {};
  const removed: string[] = [];
  for (const [id, s] of Object.entries(next)) {
    if (only && !only.has(id)) continue;
    if (!same(prev[id], s)) changed[id] = s;
  }
  for (const id of Object.keys(prev)) {
    if (only && !only.has(id)) continue;
    if (!(id in next)) removed.push(id);
  }
  return { changed, removed };
}

/** Keys whose value differs (settings sync). */
export function diffValues(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(next)) if (!same(prev[k], v)) out[k] = v;
  return out;
}

// ------------------------------------------------------------------ secondary window state

export interface SecondaryState {
  label: string;
  phase: 'connecting' | 'ready' | 'closing';
  entry: OsWindowEntry | null;
  session: SessionInfo | null;
  /** Window states this OS window shows. */
  windows: Record<string, WindowState>;
}

export function initialSecondary(label: string): SecondaryState {
  return { label, phase: 'connecting', entry: null, session: null, windows: {} };
}

/**
 * What a secondary window keeps from bus messages: its entry and window states. Messages for
 * other windows, from itself, or about windows it does not show leave the state unchanged
 * (same object), so callers can skip work.
 */
export function reduceSecondary(s: SecondaryState, m: BusMsg): SecondaryState {
  if (m.from === s.label) return s;
  switch (m.t) {
    case 'init': {
      if (m.to !== s.label) return s;
      const windows: Record<string, WindowState> = {};
      for (const id of m.entry.ids) if (m.windows[id]) windows[id] = m.windows[id]!;
      return { ...s, phase: 'ready', entry: m.entry, session: m.session, windows };
    }
    case 'windows': {
      if (s.phase !== 'ready' || m.from !== MAIN_LABEL) return s;
      let windows = s.windows;
      for (const [id, w] of Object.entries(m.windows)) {
        if (!(id in s.windows) || same(s.windows[id], w)) continue;
        if (windows === s.windows) windows = { ...s.windows };
        windows[id] = w;
      }
      for (const id of m.removed ?? []) {
        if (!(id in windows)) continue;
        if (windows === s.windows) windows = { ...s.windows };
        delete windows[id];
      }
      return windows === s.windows ? s : { ...s, windows };
    }
    case 'close':
      return m.to === s.label ? { ...s, phase: 'closing' } : s;
    default:
      return s;
  }
}

// ------------------------------------------------------------------ workspace → OS window

/**
 * Gives every window of a workspace tab a new id (so it can live next to the same workspace in
 * the main window) and rewrites the dockview layout to match. Ids are matched as whole JSON
 * strings, so a title that merely contains an id is left alone.
 */
export function remapTab(
  layout: unknown,
  windows: Record<string, WindowState>,
  newId: (old: string) => string,
): { layout: unknown; windows: Record<string, WindowState>; map: Record<string, string> } {
  const map: Record<string, string> = {};
  const out: Record<string, WindowState> = {};
  for (const [id, w] of Object.entries(windows)) {
    const n = newId(id);
    map[id] = n;
    out[n] = w;
  }
  const remap = (v: unknown): unknown => {
    if (typeof v === 'string') return map[v] ?? v;
    if (Array.isArray(v)) return v.map(remap);
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) o[map[k] ?? k] = remap(x);
      return o;
    }
    return v;
  };
  return { layout: layout == null ? null : remap(layout), windows: out, map };
}
