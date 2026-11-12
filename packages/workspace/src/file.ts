/**
 * `.htworkspace` files (P25 / P37): a versioned JSON envelope around one saved workspace.
 *
 * Every file is treated as hostile: size, depth, key count and string length are capped, prototype
 * keys are dropped, every window is checked field by field, and a dockview layout that references
 * unknown windows is discarded (the tab is rebuilt from its windows instead). Older formats are
 * migrated step by step up to `WORKSPACE_FILE_VERSION`.
 */
import {
  CHART_TEMPLATES,
  LINK_COLOR_IDS,
  type ChartWindowState,
  type DisplaySnapshot,
  type DomWindowState,
  type LinkColor,
  type ModuleWindowState,
  type MonitorInfo,
  type PanelSpec,
  type Rect,
  type WindowState,
  type WorkspaceDoc,
  type WorkspaceTab,
} from './model';

export const WORKSPACE_FILE_EXT = '.htworkspace';
export const WORKSPACE_FILE_FORMAT = 'htworkspace';
/** Current file format version. v1 = raw app document, v2 = envelope, v3 = envelope + meta + display. */
export const WORKSPACE_FILE_VERSION = 3;

export const LIMITS = {
  fileBytes: 5_000_000,
  depth: 48,
  nodes: 200_000,
  string: 20_000,
  name: 120,
  description: 500,
  tabs: 50,
  windowsPerTab: 200,
  monitors: 16,
} as const;

/** Metadata shown in the Workspaces manager. */
export interface WorkspaceMeta {
  id: string;
  name: string;
  description: string;
  favourite: boolean;
  createdAt: number;
  updatedAt: number;
  /** Id of the starter this workspace came from, if any. */
  starter?: string;
}

/** One workspace as stored in the library and in files. */
export interface StoredWorkspace {
  meta: WorkspaceMeta;
  doc: WorkspaceDoc;
}

export interface HtWorkspaceFile {
  format: typeof WORKSPACE_FILE_FORMAT;
  version: typeof WORKSPACE_FILE_VERSION;
  app: string;
  exportedAt: number;
  workspace: StoredWorkspace;
}

export type ParseResult =
  | { ok: true; workspace: StoredWorkspace; migratedFrom: number; warnings: string[] }
  | { ok: false; error: string };

class InvalidFile extends Error {}
const fail = (msg: string): never => {
  throw new InvalidFile(msg);
};

// ------------------------------------------------------------------ safe JSON

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/**
 * Deep copy of parsed JSON with hard limits. Prototype keys are dropped (never copied onto a plain
 * object), non-finite numbers rejected, control characters stripped from strings.
 */
export function safeJson(value: unknown, budget = { nodes: LIMITS.nodes }, depth = 0): Json {
  if (depth > LIMITS.depth) fail('The file is nested too deeply');
  if (--budget.nodes < 0) fail('The file is too large');
  if (value === null) return null;
  switch (typeof value) {
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) fail('The file contains an invalid number');
      return value;
    case 'string':
      if (value.length > LIMITS.string) fail('The file contains an over-long text value');
      return cleanText(value);
    case 'object': {
      if (Array.isArray(value)) return value.map((v) => safeJson(v, budget, depth + 1));
      const out: { [k: string]: Json } = {};
      for (const k of Object.keys(value as object)) {
        if (FORBIDDEN_KEYS.has(k) || k.length > 200) continue;
        out[k] = safeJson((value as Record<string, unknown>)[k], budget, depth + 1);
      }
      return out;
    }
    default:
      return fail('The file contains an unsupported value');
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
function cleanText(s: string): string {
  return s.replace(CONTROL, '');
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

const ID = /^[A-Za-z0-9._:-]{1,80}$/;
const INSTRUMENT = /^[A-Za-z0-9._:/@+-]{1,120}$/;
const MODULE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function text(v: unknown, max: number, what: string, fallback?: string): string {
  if (typeof v !== 'string') {
    if (fallback !== undefined) return fallback;
    return fail(`${what} must be text`);
  }
  const s = v.trim().slice(0, max);
  if (!s && fallback === undefined) fail(`${what} is empty`);
  return s || (fallback ?? '');
}

// ------------------------------------------------------------------ windows

const TEMPLATE_IDS = (): string[] => CHART_TEMPLATES.map((t) => t.id);

function link(v: unknown): LinkColor {
  return typeof v === 'string' && (LINK_COLOR_IDS as string[]).includes(v)
    ? (v as LinkColor)
    : 'none';
}

function ext(v: unknown): Record<string, unknown> | undefined {
  return isObj(v) ? (v as Record<string, unknown>) : undefined;
}

function timeframe(v: unknown): ChartWindowState['timeframe'] {
  const def = { kind: 'time' as const, ms: 300_000 };
  if (!isObj(v)) return def;
  if (v.kind === 'time') return num(v.ms, 100, 31 * 86_400_000) ? { kind: 'time', ms: v.ms } : def;
  if (v.kind === 'tick' || v.kind === 'volume' || v.kind === 'delta')
    return num(v.n, 1, 1e9) ? { kind: v.kind, n: v.n } : def;
  if (v.kind === 'range') return num(v.ticks, 1, 1e6) ? { kind: 'range', ticks: v.ticks } : def;
  return def;
}

/** Validates one window; throws with a readable reason. */
export function validateWindow(raw: unknown, where = 'window'): WindowState {
  if (!isObj(raw)) return fail(`${where} is not an object`);
  if (raw.kind === 'chart') {
    const template = raw.template;
    if (typeof template !== 'string' || !TEMPLATE_IDS().includes(template))
      fail(`${where}: unknown chart type "${String(template).slice(0, 40)}"`);
    if (typeof raw.instrumentId !== 'string' || !INSTRUMENT.test(raw.instrumentId))
      fail(`${where}: invalid instrument`);
    const s: ChartWindowState = {
      kind: 'chart',
      instrumentId: raw.instrumentId as string,
      template: template as ChartWindowState['template'],
      timeframe: timeframe(raw.timeframe),
      lots: num(raw.lots, 0, 1e6) ? raw.lots : 1,
      link: link(raw.link),
      footprintMode:
        typeof raw.footprintMode === 'string' && /^[a-z0-9-]{1,40}$/i.test(raw.footprintMode)
          ? raw.footprintMode
          : 'volume',
      heatColumnMs: raw.heatColumnMs === 1000 || raw.heatColumnMs === 5000 ? raw.heatColumnMs : 250,
      minLots: num(raw.minLots, 0, 1e9) ? raw.minLots : 1,
    };
    const e = ext(raw.ext);
    if (e) s.ext = e;
    return s;
  }
  if (raw.kind === 'dom') {
    if (typeof raw.instrumentId !== 'string' || !INSTRUMENT.test(raw.instrumentId))
      fail(`${where}: invalid instrument`);
    const s: DomWindowState = {
      kind: 'dom',
      instrumentId: raw.instrumentId as string,
      lots: num(raw.lots, 0, 1e6) ? raw.lots : 1,
      link: link(raw.link),
      grouping: num(raw.grouping, 1, 1000) ? Math.round(raw.grouping) : 1,
    };
    const e = ext(raw.ext);
    if (e) s.ext = e;
    return s;
  }
  if (raw.kind === 'module') {
    if (typeof raw.module !== 'string' || !MODULE_ID.test(raw.module))
      fail(`${where}: invalid module id`);
    const s: ModuleWindowState = { kind: 'module', module: raw.module as string };
    const p = ext(raw.params);
    if (p) s.params = p;
    return s;
  }
  return fail(`${where}: unknown window kind`);
}

// ------------------------------------------------------------------ dockview layout

const COMPONENTS = new Set(['chart', 'dom', 'module']);

/** Panel ids a dockview layout references (grid leaves, floating and popout groups). */
export function layoutPanelIds(layout: unknown): string[] {
  if (!isObj(layout) || !isObj(layout.panels)) return [];
  return Object.keys(layout.panels);
}

/**
 * Checks a dockview `toJSON()` value against the tab's windows. Returns null when the layout cannot
 * be trusted (the tab is then rebuilt from its windows).
 */
export function validateLayout(
  layout: unknown,
  windows: Record<string, WindowState>,
): Record<string, unknown> | null {
  if (!isObj(layout) || !isObj(layout.grid) || !isObj(layout.panels)) return null;
  if (!isObj(layout.grid.root)) return null;
  if (!num(layout.grid.width, 0, 1e5) || !num(layout.grid.height, 0, 1e5)) return null;
  const panelIds = Object.keys(layout.panels);
  if (panelIds.length === 0 || panelIds.length > LIMITS.windowsPerTab) return null;
  for (const id of panelIds) {
    const p = layout.panels[id];
    if (!isObj(p) || p.id !== id || !windows[id]) return null;
    const comp = p.contentComponent;
    if (typeof comp !== 'string' || !COMPONENTS.has(comp) || comp !== windows[id]!.kind)
      return null;
  }
  // Every view in a group must be a known panel.
  const groups: unknown[] = [];
  const walk = (n: unknown, d: number) => {
    if (d > 32 || !isObj(n)) return;
    if (n.type === 'leaf') groups.push(n.data);
    else if (Array.isArray(n.data)) for (const c of n.data) walk(c, d + 1);
  };
  walk(layout.grid.root, 0);
  for (const f of Array.isArray(layout.floatingGroups) ? layout.floatingGroups : [])
    if (isObj(f)) groups.push(f.data);
  for (const f of Array.isArray(layout.popoutGroups) ? layout.popoutGroups : [])
    if (isObj(f)) groups.push(f.data);
  for (const g of groups) {
    if (!isObj(g) || !Array.isArray(g.views)) return null;
    for (const v of g.views) if (typeof v !== 'string' || !windows[v]) return null;
  }
  return layout;
}

// ------------------------------------------------------------------ tabs / doc

const DIRS = new Set(['right', 'below', 'left', 'above', 'within']);

function validateSpecs(
  raw: unknown,
  windows: Record<string, WindowState>,
): PanelSpec[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PanelSpec[] = [];
  const seen = new Set<string>();
  for (const s of raw.slice(0, LIMITS.windowsPerTab)) {
    if (!isObj(s) || typeof s.id !== 'string' || !windows[s.id] || seen.has(s.id)) continue;
    const spec: PanelSpec = { id: s.id, state: windows[s.id]! };
    if (
      isObj(s.position) &&
      typeof s.position.ref === 'string' &&
      seen.has(s.position.ref) &&
      typeof s.position.dir === 'string' &&
      DIRS.has(s.position.dir)
    )
      spec.position = { ref: s.position.ref, dir: s.position.dir as 'right' };
    if (num(s.size, 0.05, 0.95)) spec.size = s.size;
    seen.add(s.id);
    out.push(spec);
  }
  return out;
}

/** Default arrangement for windows without a layout: tile left-to-right, then down. */
export function specsFromWindows(windows: Record<string, WindowState>): PanelSpec[] {
  const ids = Object.keys(windows);
  const cols = Math.max(1, Math.ceil(Math.sqrt(ids.length)));
  return ids.map((id, i) => {
    const spec: PanelSpec = { id, state: windows[id]! };
    if (i > 0) {
      const col = i % cols;
      spec.position =
        col === 0 ? { ref: ids[i - cols]!, dir: 'below' } : { ref: ids[i - 1]!, dir: 'right' };
    }
    return spec;
  });
}

function validateTab(raw: unknown, i: number, warnings: string[]): WorkspaceTab {
  const where = `Layout ${i + 1}`;
  if (!isObj(raw)) return fail(`${where} is not an object`);
  const id = typeof raw.id === 'string' && ID.test(raw.id) ? raw.id : `tab-${i + 1}`;
  const name = text(raw.name, LIMITS.name, `${where} name`, `Layout ${i + 1}`);
  if (!isObj(raw.windows)) return fail(`${where} has no windows`);
  const keys = Object.keys(raw.windows);
  if (keys.length > LIMITS.windowsPerTab) fail(`${where} has too many windows`);
  const windows: Record<string, WindowState> = {};
  for (const k of keys) {
    if (!ID.test(k)) fail(`${where}: invalid window id`);
    windows[k] = validateWindow(raw.windows[k], `${where}, window "${k}"`);
  }
  let layout: unknown = null;
  if (raw.layout !== null && raw.layout !== undefined) {
    layout = validateLayout(raw.layout, windows);
    if (!layout) warnings.push(`${where}: the window arrangement was invalid and was rebuilt`);
  }
  const tab: WorkspaceTab = {
    id,
    name,
    layout,
    windows,
    tradingPanel: raw.tradingPanel === true,
  };
  const specs = validateSpecs(raw.specs, windows);
  if (!layout) tab.specs = specs && specs.length ? specs : specsFromWindows(windows);
  return tab;
}

function rect(v: unknown): Rect | null {
  if (!isObj(v)) return null;
  const { x, y, width, height } = v;
  if (!num(x, -1e5, 1e5) || !num(y, -1e5, 1e5)) return null;
  if (!num(width, 1, 1e5) || !num(height, 1, 1e5)) return null;
  return { x, y, width, height };
}

export function validateDisplay(raw: unknown): DisplaySnapshot | undefined {
  if (!isObj(raw)) return undefined;
  const main = rect(raw.main);
  if (!main) return undefined;
  const monitors: MonitorInfo[] = [];
  for (const m of Array.isArray(raw.monitors) ? raw.monitors.slice(0, LIMITS.monitors) : []) {
    const r = rect(m);
    if (!r || !isObj(m)) continue;
    monitors.push({
      ...r,
      name: typeof m.name === 'string' ? m.name.slice(0, 80) : `Monitor ${monitors.length + 1}`,
      primary: m.primary === true,
      scale: num(m.scale, 0.25, 8) ? m.scale : 1,
    });
  }
  const c = isObj(raw.container) ? raw.container : {};
  const windows: DisplaySnapshot['windows'] = {};
  if (isObj(raw.windows))
    for (const [k, w] of Object.entries(raw.windows).slice(0, LIMITS.windowsPerTab)) {
      const r = rect(w);
      if (r && ID.test(k) && isObj(w))
        windows[k] = { ...r, monitor: typeof w.monitor === 'string' ? w.monitor.slice(0, 80) : '' };
    }
  return {
    monitors,
    main,
    container: {
      width: num(c.width, 1, 1e5) ? c.width : main.width,
      height: num(c.height, 1, 1e5) ? c.height : main.height,
    },
    windows,
  };
}

/** Validates an app workspace document (as stored or inside a file). */
export function validateDoc(raw: unknown, warnings: string[] = []): WorkspaceDoc {
  if (!isObj(raw)) return fail('The workspace is not an object');
  const name = text(raw.name, LIMITS.name, 'Workspace name', 'Imported workspace');
  if (!Array.isArray(raw.tabs) || raw.tabs.length === 0)
    return fail('The workspace has no layouts');
  if (raw.tabs.length > LIMITS.tabs) fail('The workspace has too many layouts');
  const tabs = raw.tabs.map((t, i) => validateTab(t, i, warnings));
  // Tab ids must be unique.
  const seen = new Set<string>();
  for (const t of tabs) {
    while (seen.has(t.id)) t.id = `${t.id}-${seen.size}`;
    seen.add(t.id);
  }
  const activeTab =
    typeof raw.activeTab === 'string' && tabs.some((t) => t.id === raw.activeTab)
      ? raw.activeTab
      : tabs[0]!.id;
  const doc: WorkspaceDoc = {
    version: 1,
    name,
    activeTab,
    tabs,
    savedAt: num(raw.savedAt, 0, 1e14) ? raw.savedAt : 0,
  };
  const display = validateDisplay(raw.display);
  if (display) doc.display = display;
  return doc;
}

export function validateMeta(raw: unknown, doc: WorkspaceDoc, now: number): WorkspaceMeta {
  const m = isObj(raw) ? raw : {};
  const meta: WorkspaceMeta = {
    id: typeof m.id === 'string' && ID.test(m.id) ? m.id : newWorkspaceId(now),
    name: text(m.name, LIMITS.name, 'Workspace name', doc.name),
    description: text(m.description, LIMITS.description, 'Description', ''),
    favourite: m.favourite === true,
    createdAt: num(m.createdAt, 0, 1e14) ? m.createdAt : now,
    updatedAt: num(m.updatedAt, 0, 1e14) ? m.updatedAt : now,
  };
  if (typeof m.starter === 'string' && ID.test(m.starter)) meta.starter = m.starter;
  return meta;
}

let idSeq = 0;
export function newWorkspaceId(now = Date.now()): string {
  return `ws-${now.toString(36)}${(idSeq++).toString(36)}${Math.floor(Math.random() * 1296)
    .toString(36)
    .padStart(2, '0')}`;
}

// ------------------------------------------------------------------ migrations

/** v1 (raw app document, no envelope) → v2 envelope. */
function migrate1to2(doc: Record<string, unknown>): Record<string, unknown> {
  return { format: WORKSPACE_FILE_FORMAT, version: 2, exportedAt: Date.now(), workspace: doc };
}

/**
 * v2 → v3: workspace moves to `{ meta, doc }`; the old top-level `description` / `favourite`
 * fields become meta; monitor info (v2 `monitors` + `mainWindow`) becomes `doc.display`.
 */
function migrate2to3(f: Record<string, unknown>): Record<string, unknown> {
  const w = isObj(f.workspace) ? { ...f.workspace } : {};
  const meta: Record<string, unknown> = {
    name: w.name,
    description: f.description ?? w.description,
    favourite: f.favourite ?? w.favourite,
  };
  delete w.description;
  delete w.favourite;
  if (!w.display && isObj(w.mainWindow))
    w.display = { main: w.mainWindow, monitors: w.monitors, windows: {} };
  delete w.mainWindow;
  delete w.monitors;
  return {
    format: WORKSPACE_FILE_FORMAT,
    version: 3,
    app: typeof f.app === 'string' ? f.app : 'HT Flow',
    exportedAt: f.exportedAt,
    workspace: { meta, doc: w },
  };
}

const MIGRATIONS: Record<number, (f: Record<string, unknown>) => Record<string, unknown>> = {
  1: migrate1to2,
  2: migrate2to3,
};

/** Detects the version of a parsed file and migrates it to the current envelope. */
export function migrateFile(raw: unknown): { file: Record<string, unknown>; from: number } {
  if (!isObj(raw)) return fail('Not a workspace file');
  let version: number;
  let cur: Record<string, unknown> = raw;
  if (raw.format === WORKSPACE_FILE_FORMAT) {
    if (!Number.isInteger(raw.version) || (raw.version as number) < 2)
      fail('Unknown workspace file version');
    version = raw.version as number;
  } else if (raw.version === 1 && Array.isArray(raw.tabs)) version = 1;
  else return fail('Not an HT Flow workspace file');
  if (version > WORKSPACE_FILE_VERSION)
    fail(`This file was made by a newer HT Flow (format v${version}); update the app to open it`);
  const from = version;
  while (version < WORKSPACE_FILE_VERSION) {
    cur = MIGRATIONS[version]!(cur);
    version++;
  }
  return { file: cur, from };
}

// ------------------------------------------------------------------ public API

/** Parses and validates a `.htworkspace` file (or a legacy raw workspace document). */
export function parseWorkspaceFile(input: string, now = Date.now()): ParseResult {
  try {
    if (typeof input !== 'string') fail('Not a text file');
    if (input.length > LIMITS.fileBytes) fail('The file is larger than 5 MB');
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.replace(/^\uFEFF/, ''));
    } catch {
      return fail('The file is not valid JSON');
    }
    return parseWorkspaceValue(parsed, now);
  } catch (e) {
    if (e instanceof InvalidFile) return { ok: false, error: e.message };
    if (e instanceof RangeError) return { ok: false, error: 'The file is nested too deeply' };
    throw e;
  }
}

/** Same as parseWorkspaceFile for an already-parsed value. */
export function parseWorkspaceValue(value: unknown, now = Date.now()): ParseResult {
  try {
    const clean = safeJson(value);
    const { file, from } = migrateFile(clean);
    const w = isObj(file.workspace) ? file.workspace : fail('The file has no workspace');
    const warnings: string[] = [];
    const doc = validateDoc(w.doc, warnings);
    const meta = validateMeta(w.meta, doc, now);
    doc.name = meta.name;
    return { ok: true, workspace: { meta, doc }, migratedFrom: from, warnings };
  } catch (e) {
    if (e instanceof InvalidFile) return { ok: false, error: e.message };
    if (e instanceof RangeError) return { ok: false, error: 'The file is nested too deeply' };
    throw e;
  }
}

/** Serialises a workspace as a `.htworkspace` file (pretty JSON). */
export function serializeWorkspaceFile(ws: StoredWorkspace, now = Date.now()): string {
  const file: HtWorkspaceFile = {
    format: WORKSPACE_FILE_FORMAT,
    version: WORKSPACE_FILE_VERSION,
    app: 'HT Flow',
    exportedAt: now,
    workspace: ws,
  };
  return JSON.stringify(file, null, 2);
}

/** A file name that is safe on Windows: "Scalping NQ.htworkspace". */
export function workspaceFileName(name: string): string {
  const base = name
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(CONTROL, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 80);
  return `${base || 'workspace'}${WORKSPACE_FILE_EXT}`;
}
