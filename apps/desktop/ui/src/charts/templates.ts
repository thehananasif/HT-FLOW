/**
 * User chart templates (P09): a template is the full chart state — base chart type, display mode,
 * colours, panes, indicators and their settings, footprint / heatmap settings and scale — as JSON.
 * Pure functions here; persistence lives in templateStore.ts.
 */
import type { AssetClass } from '@htflow/market-data';
import { CHART_TEMPLATES, type ChartTemplateId, type ChartWindowState } from '@htflow/workspace';
import { diffFromDefaults, normalizeSettings, type ChartSettings } from './settings/schema';
import { baseSettings, chartSettings, extState, SETTINGS_EXT } from './settings/state';
import { STYLE_PRESETS } from './presets';

export const TEMPLATE_KIND = 'htflow.chart-template';
export const TEMPLATE_FILE_KIND = 'htflow.chart-templates';
export const TEMPLATE_EXT = '.httemplate';

/** Extension data that belongs in a template (drawings, alerts and replay stay with the window). */
export const TEMPLATE_EXT_KEYS = ['indicators'];

export interface ChartTemplateState {
  template: ChartTemplateId;
  timeframe?: ChartWindowState['timeframe'];
  footprintMode: string;
  heatColumnMs: ChartWindowState['heatColumnMs'];
  minLots: number;
  /** Chart settings that differ from the defaults. */
  settings: ChartSettings;
  panes?: Record<string, number>;
  /** Extension data (indicators) by extension id. */
  ext?: Record<string, unknown>;
}

export interface UserChartTemplate {
  kind: typeof TEMPLATE_KIND;
  version: 1;
  id: string;
  name: string;
  favourite: boolean;
  /** Built-in style presets cannot be renamed or deleted. */
  preset?: boolean;
  createdAt: number;
  updatedAt: number;
  state: ChartTemplateState;
}

export interface TemplateLibrary {
  templates: UserChartTemplate[];
  /** Default template id per instrument class. */
  defaults: Partial<Record<AssetClass, string>>;
  /** Apply the class default when a chart's instrument changes. */
  applyOnInstrumentChange: boolean;
  /** Starred built-in style presets (ids "preset:…"). */
  favouritePresets: string[];
}

export const EMPTY_LIBRARY: TemplateLibrary = {
  templates: [],
  defaults: {},
  applyOnInstrumentChange: false,
  favouritePresets: [],
};

/** Built-in style presets followed by the user's templates (presets carry their star state). */
export function allTemplates(lib: TemplateLibrary): UserChartTemplate[] {
  return [
    ...STYLE_PRESETS.map((p) => ({ ...p, favourite: lib.favouritePresets.includes(p.id) })),
    ...lib.templates,
  ];
}

export const ASSET_CLASSES: { value: AssetClass; label: string }[] = [
  { value: 'crypto', label: 'Crypto' },
  { value: 'future', label: 'Futures' },
  { value: 'stock', label: 'Stocks' },
  { value: 'index', label: 'Indices' },
  { value: 'option', label: 'Options' },
];

let seq = 0;
export function newTemplateId(now = Date.now()): string {
  seq = (seq + 1) % 1e6;
  return `tpl-${now.toString(36)}-${seq.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** Captures the template state of a chart window. */
export function captureState(s: ChartWindowState): ChartTemplateState {
  const e = extState(s);
  const ext: Record<string, unknown> = {};
  for (const k of TEMPLATE_EXT_KEYS)
    if (s.ext?.[k] !== undefined) ext[k] = structuredClone(s.ext[k]);
  return {
    template: s.template,
    timeframe: structuredClone(s.timeframe),
    footprintMode: s.footprintMode,
    heatColumnMs: s.heatColumnMs,
    minLots: s.minLots,
    settings: diffFromDefaults(chartSettings(s)),
    ...(e.panes ? { panes: { ...e.panes } } : {}),
    ...(Object.keys(ext).length ? { ext } : {}),
  };
}

export function makeTemplate(
  name: string,
  s: ChartWindowState,
  now = Date.now(),
): UserChartTemplate {
  return {
    kind: TEMPLATE_KIND,
    version: 1,
    id: newTemplateId(now),
    name: name.trim() || 'Untitled template',
    favourite: false,
    createdAt: now,
    updatedAt: now,
    state: captureState(s),
  };
}

/** The window-state patch that applies a template (instrument, link and lots are kept). */
export function applyTemplate(
  s: ChartWindowState,
  t: UserChartTemplate,
): Partial<ChartWindowState> {
  const st = t.state;
  const cur = extState(s);
  const ext: Record<string, unknown> = { ...(s.ext ?? {}) };
  for (const k of TEMPLATE_EXT_KEYS) {
    if (st.ext && k in st.ext) ext[k] = structuredClone(st.ext[k]);
  }
  const base = baseSettings();
  ext[SETTINGS_EXT] = {
    ...cur,
    settings: diffFromDefaults(normalizeSettings(st.settings), base),
    panes: st.panes ? { ...st.panes } : undefined,
    templateId: t.id,
  };
  return {
    template: st.template,
    ...(st.timeframe ? { timeframe: structuredClone(st.timeframe) } : {}),
    footprintMode: st.footprintMode,
    heatColumnMs: st.heatColumnMs,
    minLots: st.minLots,
    ext,
  };
}

/** Unique name: "Name", "Name (2)", "Name (3)" … */
export function uniqueName(name: string, taken: Iterable<string>): string {
  const set = new Set([...taken].map((n) => n.toLowerCase()));
  const base = name.trim() || 'Untitled template';
  if (!set.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const n = `${base} (${i})`;
    if (!set.has(n.toLowerCase())) return n;
  }
}

export function addTemplate(lib: TemplateLibrary, t: UserChartTemplate): TemplateLibrary {
  const name = uniqueName(
    t.name,
    lib.templates.map((x) => x.name),
  );
  return { ...lib, templates: [...lib.templates, { ...t, name }] };
}

/** Overwrites a template's state (Save over existing). */
export function updateTemplate(
  lib: TemplateLibrary,
  id: string,
  s: ChartWindowState,
  now = Date.now(),
): TemplateLibrary {
  return {
    ...lib,
    templates: lib.templates.map((t) =>
      t.id === id && !t.preset ? { ...t, state: captureState(s), updatedAt: now } : t,
    ),
  };
}

export function renameTemplate(
  lib: TemplateLibrary,
  id: string,
  name: string,
  now = Date.now(),
): TemplateLibrary {
  const others = lib.templates.filter((t) => t.id !== id).map((t) => t.name);
  return {
    ...lib,
    templates: lib.templates.map((t) =>
      t.id === id && !t.preset ? { ...t, name: uniqueName(name, others), updatedAt: now } : t,
    ),
  };
}

export function duplicateTemplate(
  lib: TemplateLibrary,
  id: string,
  now = Date.now(),
): TemplateLibrary {
  const src = lib.templates.find((t) => t.id === id);
  if (!src) return lib;
  const copy: UserChartTemplate = {
    ...structuredClone(src),
    id: newTemplateId(now),
    name: `${src.name} copy`,
    favourite: false,
    createdAt: now,
    updatedAt: now,
  };
  delete copy.preset;
  return addTemplate(lib, copy);
}

export function deleteTemplate(lib: TemplateLibrary, id: string): TemplateLibrary {
  const t = lib.templates.find((x) => x.id === id);
  if (!t || t.preset) return lib;
  const defaults = { ...lib.defaults };
  for (const k of Object.keys(defaults) as AssetClass[]) if (defaults[k] === id) delete defaults[k];
  return { ...lib, templates: lib.templates.filter((x) => x.id !== id), defaults };
}

export function toggleFavourite(lib: TemplateLibrary, id: string): TemplateLibrary {
  if (id.startsWith('preset:')) {
    const has = lib.favouritePresets.includes(id);
    return {
      ...lib,
      favouritePresets: has
        ? lib.favouritePresets.filter((x) => x !== id)
        : [...lib.favouritePresets, id],
    };
  }
  return {
    ...lib,
    templates: lib.templates.map((t) => (t.id === id ? { ...t, favourite: !t.favourite } : t)),
  };
}

export function setClassDefault(
  lib: TemplateLibrary,
  cls: AssetClass,
  id: string | null,
): TemplateLibrary {
  const defaults = { ...lib.defaults };
  if (id) defaults[cls] = id;
  else delete defaults[cls];
  return { ...lib, defaults };
}

export function defaultFor(lib: TemplateLibrary, cls: AssetClass): UserChartTemplate | undefined {
  const id = lib.defaults[cls];
  return id ? allTemplates(lib).find((t) => t.id === id) : undefined;
}

// ------------------------------------------------------------------ JSON import / export

const TEMPLATE_IDS = new Set<string>(CHART_TEMPLATES.map((t) => t.id));

function validState(v: unknown): ChartTemplateState | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as Partial<ChartTemplateState>;
  if (typeof s.template !== 'string' || !TEMPLATE_IDS.has(s.template)) return null;
  const heat = [250, 1000, 5000].includes(s.heatColumnMs as number)
    ? (s.heatColumnMs as ChartTemplateState['heatColumnMs'])
    : 250;
  const tf = s.timeframe as ChartTemplateState['timeframe'];
  const tfOk =
    !!tf &&
    typeof tf === 'object' &&
    typeof (tf as { kind?: unknown }).kind === 'string' &&
    Object.values(tf).every((x) => typeof x === 'string' || (typeof x === 'number' && x > 0));
  const panes: Record<string, number> = {};
  if (s.panes && typeof s.panes === 'object')
    for (const [k, h] of Object.entries(s.panes))
      if (typeof h === 'number' && h >= 16 && h <= 4000) panes[k] = h;
  const ext: Record<string, unknown> = {};
  if (s.ext && typeof s.ext === 'object')
    for (const k of TEMPLATE_EXT_KEYS)
      if (k in s.ext) ext[k] = (s.ext as Record<string, unknown>)[k];
  return {
    template: s.template as ChartTemplateId,
    ...(tfOk ? { timeframe: tf } : {}),
    footprintMode: typeof s.footprintMode === 'string' ? s.footprintMode : 'volume',
    heatColumnMs: heat,
    minLots: typeof s.minLots === 'number' && s.minLots > 0 ? s.minLots : 1,
    settings: diffFromDefaults(normalizeSettings(s.settings)),
    ...(Object.keys(panes).length ? { panes } : {}),
    ...(Object.keys(ext).length ? { ext } : {}),
  };
}

/** Validates one template object; returns null if unusable. */
export function parseTemplate(v: unknown, now = Date.now()): UserChartTemplate | null {
  if (!v || typeof v !== 'object') return null;
  const t = v as Partial<UserChartTemplate>;
  if (t.kind !== TEMPLATE_KIND) return null;
  const state = validState(t.state);
  if (!state || typeof t.name !== 'string' || !t.name.trim()) return null;
  return {
    kind: TEMPLATE_KIND,
    version: 1,
    id: typeof t.id === 'string' && t.id ? t.id.slice(0, 80) : newTemplateId(now),
    name: t.name.trim().slice(0, 80),
    favourite: t.favourite === true,
    createdAt: typeof t.createdAt === 'number' ? t.createdAt : now,
    updatedAt: typeof t.updatedAt === 'number' ? t.updatedAt : now,
    state,
  };
}

/** `.httemplate` file content for one or more templates. */
export function serializeTemplates(list: UserChartTemplate[]): string {
  return JSON.stringify(
    {
      kind: TEMPLATE_FILE_KIND,
      version: 1,
      templates: list.map((t) => {
        const c: Partial<UserChartTemplate> = { ...t };
        delete c.preset;
        return c;
      }),
    },
    null,
    2,
  );
}

/** Parses a `.httemplate` file (or a single template object). Invalid entries are reported. */
export function parseTemplatesFile(
  text: string,
  now = Date.now(),
): { templates: UserChartTemplate[]; errors: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { templates: [], errors: ['Not a JSON file'] };
  }
  const list: unknown[] =
    raw && typeof raw === 'object' && (raw as { kind?: string }).kind === TEMPLATE_FILE_KIND
      ? Array.isArray((raw as { templates?: unknown }).templates)
        ? ((raw as { templates: unknown[] }).templates as unknown[])
        : []
      : [raw];
  const templates: UserChartTemplate[] = [];
  const errors: string[] = [];
  list.forEach((x, i) => {
    const t = parseTemplate(x, now);
    if (t) templates.push(t);
    else errors.push(`Template ${i + 1} is not a valid chart template`);
  });
  return { templates, errors };
}

/** Imports templates; ids that already exist get a new id, names are made unique. */
export function importTemplates(
  lib: TemplateLibrary,
  list: UserChartTemplate[],
  now = Date.now(),
): TemplateLibrary {
  let next = lib;
  const ids = new Set(lib.templates.map((t) => t.id));
  for (const t of list) {
    const id = ids.has(t.id) ? newTemplateId(now) : t.id;
    ids.add(id);
    const c: UserChartTemplate = { ...t, id };
    delete c.preset;
    next = addTemplate(next, c);
  }
  return next;
}

/** Validates a stored library (from encrypted settings). */
export function parseLibrary(v: unknown): TemplateLibrary {
  if (!v || typeof v !== 'object') return { ...EMPTY_LIBRARY };
  const l = v as Partial<TemplateLibrary>;
  const templates = Array.isArray(l.templates)
    ? l.templates.map((t) => parseTemplate(t)).filter((t): t is UserChartTemplate => !!t)
    : [];
  const ids = new Set(templates.map((t) => t.id));
  const defaults: TemplateLibrary['defaults'] = {};
  if (l.defaults && typeof l.defaults === 'object')
    for (const c of ASSET_CLASSES) {
      const id = (l.defaults as Record<string, unknown>)[c.value];
      if (typeof id === 'string' && (ids.has(id) || id.startsWith('preset:')))
        defaults[c.value] = id;
    }
  const favouritePresets = Array.isArray(l.favouritePresets)
    ? l.favouritePresets.filter(
        (x): x is string => typeof x === 'string' && STYLE_PRESETS.some((p) => p.id === x),
      )
    : [];
  return {
    templates,
    defaults,
    applyOnInstrumentChange: l.applyOnInstrumentChange === true,
    favouritePresets,
  };
}
