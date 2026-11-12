/**
 * Smart DOM templates (P15): a template is an ordered column set (visibility, width, colours)
 * plus styles (palette, font, row height, centring) and behaviour (volume scope, thresholds).
 * Everything here is plain data so it can be persisted, exported and imported as JSON.
 */

export type DomColumnId =
  | 'orders'
  | 'limits'
  | 'markers'
  | 'notes'
  | 'pnl'
  | 'volume'
  | 'delta'
  | 'lastSize'
  | 'vapoc'
  | 'cumBid'
  | 'bidChg'
  | 'bid'
  | 'sells'
  | 'price'
  | 'buys'
  | 'ask'
  | 'askChg'
  | 'cumAsk';

export interface DomColumnDef {
  id: DomColumnId;
  label: string;
  /** Default width in px. */
  width: number;
  description: string;
}

/** Every column the ladder can draw, in the default order. */
export const COLUMN_DEFS: DomColumnDef[] = [
  {
    id: 'notes',
    label: 'Notes',
    width: 90,
    description: 'Your text note per price (click to edit).',
  },
  {
    id: 'orders',
    label: 'Orders',
    width: 64,
    description: 'Working orders: click to cancel, drag to move. Shows position average.',
  },
  {
    id: 'limits',
    label: 'Limits',
    width: 80,
    description: 'Limit tracking: your working size per price and estimated queue ahead.',
  },
  {
    id: 'markers',
    label: 'Stops / Ice',
    width: 70,
    description: 'Your stop orders and detected iceberg refills (×count, hidden size).',
  },
  {
    id: 'pnl',
    label: 'P&L',
    width: 70,
    description: 'P&L of the open position if closed at the price.',
  },
  {
    id: 'volume',
    label: 'Volume',
    width: 80,
    description: 'Volume at price for the session or the rolling range.',
  },
  { id: 'delta', label: 'Delta', width: 64, description: 'Buy minus sell volume at the price.' },
  { id: 'lastSize', label: 'Last', width: 52, description: 'Size of the last trade at the price.' },
  { id: 'vapoc', label: 'VA', width: 34, description: 'Value area band, POC and VAH / VAL marks.' },
  {
    id: 'cumBid',
    label: 'Σ Bid',
    width: 70,
    description: 'Cumulative bid depth from the best bid.',
  },
  { id: 'bidChg', label: 'Limit Δ', width: 54, description: 'Bid size change over the window.' },
  { id: 'bid', label: 'Bid', width: 90, description: 'Bid size with depth bar. Left-click buys.' },
  { id: 'sells', label: 'Sells', width: 56, description: 'Recent sell-aggressor executions.' },
  { id: 'price', label: 'Price', width: 84, description: 'Price ladder.' },
  { id: 'buys', label: 'Buys', width: 56, description: 'Recent buy-aggressor executions.' },
  {
    id: 'ask',
    label: 'Ask',
    width: 90,
    description: 'Ask size with depth bar. Right-click sells.',
  },
  { id: 'askChg', label: 'Limit Δ', width: 54, description: 'Ask size change over the window.' },
  {
    id: 'cumAsk',
    label: 'Σ Ask',
    width: 70,
    description: 'Cumulative ask depth from the best ask.',
  },
];

export const COLUMN_IDS = COLUMN_DEFS.map((c) => c.id);
export const columnDef = (id: DomColumnId): DomColumnDef => COLUMN_DEFS.find((c) => c.id === id)!;

export interface DomColumnConfig {
  id: DomColumnId;
  visible: boolean;
  width: number;
  /** Optional per-column colours (hex); empty = template palette. */
  bg?: string;
  fg?: string;
  /** Bar / highlight colour. */
  accent?: string;
}

export interface DomPaletteSpec {
  bg: string;
  rowAlt: string;
  grid: string;
  header: string;
  headerText: string;
  text: string;
  textDim: string;
  priceBg: string;
  lastBg: string;
  bid: string;
  ask: string;
  buy: string;
  sell: string;
  volume: string;
  order: string;
  position: string;
  pulled: string;
  stacked: string;
  iceberg: string;
  va: string;
  poc: string;
  note: string;
  spread: string;
}

export type CentringMode = 'auto' | 'always' | 'manual';

export interface DomStyle {
  fontFamily: string;
  fontSize: number;
  rowHeight: number;
  headerHeight: number;
  centring: CentringMode;
  /** Auto mode re-centres when price leaves the middle band (share of rows, 0.05–0.45). */
  centreBand: number;
  gridLines: boolean;
  palette: DomPaletteSpec;
}

export interface DomBehaviour {
  volumeScope: 'session' | 'range';
  rangeMinutes: number;
  recentSeconds: number;
  limitSeconds: number;
  pulledThreshold: number;
  stackedThreshold: number;
  flashMs: number;
  icebergMinRefills: number;
  /** Size highlighted as "big" in bid / ask cells (0 = off). */
  bigSize: number;
  lotPresets: number[];
  /** Show daily loss / position / trades limits in the header (Prop DOM). */
  showRiskLimits: boolean;
}

export interface DomTemplate {
  version: 1;
  id: string;
  name: string;
  builtin: boolean;
  columns: DomColumnConfig[];
  style: DomStyle;
  behaviour: DomBehaviour;
}

const DARK: DomPaletteSpec = {
  bg: '#0B0B0C',
  rowAlt: '#0F0F11',
  grid: '#1C1C1F',
  header: '#121214',
  headerText: '#9A9AA0',
  text: '#ECECEE',
  textDim: '#8A8A90',
  priceBg: '#151518',
  lastBg: '#2A2A2F',
  bid: '#20C77A',
  ask: '#F04A5D',
  buy: '#20C77A',
  sell: '#F04A5D',
  volume: '#5E6370',
  order: '#4FA3F7',
  position: '#E8B04B',
  pulled: '#E8B04B',
  stacked: '#B07CF0',
  iceberg: '#4FA3F7',
  va: '#2B2B31',
  poc: '#FFFFFF',
  note: '#E8B04B',
  spread: '#FFFFFF',
};

const GRAY: DomPaletteSpec = {
  ...DARK,
  bg: '#1E1F22',
  rowAlt: '#232428',
  grid: '#2E3035',
  header: '#26272B',
  headerText: '#B4B6BC',
  priceBg: '#2A2C30',
  lastBg: '#44474E',
  volume: '#6E7380',
  va: '#33363C',
};

const LIGHT: DomPaletteSpec = {
  bg: '#FFFFFF',
  rowAlt: '#F6F6F7',
  grid: '#E4E4E7',
  header: '#F1F1F3',
  headerText: '#5A5A60',
  text: '#141416',
  textDim: '#6A6A70',
  priceBg: '#EDEDF0',
  lastBg: '#D6D6DB',
  bid: '#139A5C',
  ask: '#D3263C',
  buy: '#139A5C',
  sell: '#D3263C',
  volume: '#A3A7B2',
  order: '#1F6FD1',
  position: '#B07A10',
  pulled: '#C8860F',
  stacked: '#8048C8',
  iceberg: '#1F6FD1',
  va: '#E6E7EC',
  poc: '#141416',
  note: '#9A6A00',
  spread: '#141416',
};

const BASE_STYLE: DomStyle = {
  fontFamily: 'Geist',
  fontSize: 12,
  rowHeight: 22,
  headerHeight: 24,
  centring: 'auto',
  centreBand: 0.3,
  gridLines: false,
  palette: DARK,
};

export const DEFAULT_BEHAVIOUR: DomBehaviour = {
  volumeScope: 'session',
  rangeMinutes: 30,
  recentSeconds: 10,
  limitSeconds: 10,
  pulledThreshold: 20,
  stackedThreshold: 20,
  flashMs: 1200,
  icebergMinRefills: 2,
  bigSize: 0,
  lotPresets: [1, 2, 5, 10],
  showRiskLimits: false,
};

function cols(ids: DomColumnId[], widths: Partial<Record<DomColumnId, number>> = {}) {
  // Visible columns in the given order, then the rest hidden (so they can be toggled on).
  const vis = ids.map((id) => ({ id, visible: true, width: widths[id] ?? columnDef(id).width }));
  const rest = COLUMN_IDS.filter((id) => !ids.includes(id)).map((id) => ({
    id,
    visible: false,
    width: columnDef(id).width,
  }));
  return [...vis, ...rest];
}

function tpl(
  id: string,
  name: string,
  columns: DomColumnConfig[],
  style: Partial<DomStyle> = {},
  behaviour: Partial<DomBehaviour> = {},
): DomTemplate {
  return {
    version: 1,
    id,
    name,
    builtin: true,
    columns,
    style: { ...BASE_STYLE, ...style, palette: { ...(style.palette ?? BASE_STYLE.palette) } },
    behaviour: { ...DEFAULT_BEHAVIOUR, ...behaviour },
  };
}

/** The 13 built-in templates, in the order of the Smart DOM menu. */
export const BUILTIN_TEMPLATES: DomTemplate[] = [
  tpl('basic-extended', 'Basic Extended', [
    ...cols(['orders', 'volume', 'price', 'bidChg', 'bid', 'sells', 'buys', 'ask', 'askChg']),
  ]),
  tpl('basic', 'Basic', cols(['orders', 'bid', 'price', 'ask'])),
  tpl(
    'compact',
    'Compact',
    cols(['orders', 'bid', 'price', 'ask'], { orders: 44, bid: 60, price: 64, ask: 60 }),
    { fontSize: 10, rowHeight: 16, headerHeight: 18 },
  ),
  tpl(
    'crypto',
    'Crypto DOM',
    cols(['orders', 'cumBid', 'bid', 'price', 'ask', 'cumAsk', 'lastSize', 'volume']),
    {},
    { bigSize: 0, pulledThreshold: 5, stackedThreshold: 5 },
  ),
  tpl(
    'dark-notes',
    'Dark (with notes)',
    cols(['notes', 'orders', 'volume', 'bid', 'sells', 'price', 'buys', 'ask']),
  ),
  tpl(
    'dark-extended',
    'Dark Extended',
    cols([
      'orders',
      'pnl',
      'volume',
      'vapoc',
      'bidChg',
      'bid',
      'sells',
      'price',
      'buys',
      'ask',
      'askChg',
      'delta',
      'markers',
    ]),
  ),
  tpl('dark', 'Dark', cols(['orders', 'volume', 'bid', 'price', 'ask'])),
  tpl('gray', 'Gray', cols(['orders', 'bid', 'price', 'ask', 'volume']), { palette: GRAY }),
  tpl('light-bid-ask', 'Light Bid-Ask', cols(['bid', 'sells', 'price', 'buys', 'ask']), {
    palette: LIGHT,
    gridLines: true,
  }),
  tpl(
    'light-extended',
    'Light Extended',
    cols([
      'orders',
      'volume',
      'cumBid',
      'bidChg',
      'bid',
      'sells',
      'price',
      'buys',
      'ask',
      'askChg',
      'cumAsk',
      'delta',
    ]),
    { palette: LIGHT, gridLines: true },
  ),
  tpl('light', 'Light', cols(['orders', 'bid', 'price', 'ask', 'volume']), {
    palette: LIGHT,
    gridLines: true,
  }),
  tpl(
    'limit-tracking',
    'Limit Tracking',
    cols(['orders', 'limits', 'bidChg', 'bid', 'price', 'ask', 'askChg', 'markers']),
    {},
    { limitSeconds: 10 },
  ),
  tpl(
    'prop',
    'Prop DOM',
    cols([
      'orders',
      'pnl',
      'limits',
      'volume',
      'vapoc',
      'bid',
      'sells',
      'price',
      'buys',
      'ask',
      'lastSize',
      'markers',
    ]),
    {},
    { showRiskLimits: true },
  ),
];

export const DEFAULT_TEMPLATE_ID = 'basic-extended';

export const builtinTemplate = (id: string): DomTemplate | undefined =>
  BUILTIN_TEMPLATES.find((t) => t.id === id);

export function cloneTemplate(t: DomTemplate): DomTemplate {
  return JSON.parse(JSON.stringify(t)) as DomTemplate;
}

// ------------------------------------------------------------------ validation

const HEX = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, d: number, lo: number, hi: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
const color = (v: unknown, d: string) => (typeof v === 'string' && HEX.test(v) ? v : d);
const optColor = (v: unknown) => (typeof v === 'string' && HEX.test(v) ? v : undefined);
const str = (v: unknown, d: string, max = 60) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : d;

/**
 * Turns untrusted data (imported JSON, old saves) into a valid template: unknown columns are
 * dropped, missing ones appended hidden, numbers clamped, colours checked. Never throws.
 */
export function sanitizeTemplate(raw: unknown, fallbackId = 'custom'): DomTemplate {
  const r = isObj(raw) ? raw : {};
  const base = builtinTemplate(String(r.id)) ?? BUILTIN_TEMPLATES[0]!;
  const seen = new Set<DomColumnId>();
  const columns: DomColumnConfig[] = [];
  if (Array.isArray(r.columns)) {
    for (const c of r.columns) {
      if (!isObj(c) || !COLUMN_IDS.includes(c.id as DomColumnId)) continue;
      const id = c.id as DomColumnId;
      if (seen.has(id)) continue;
      seen.add(id);
      const cfg: DomColumnConfig = {
        id,
        visible: c.visible !== false,
        width: Math.round(num(c.width, columnDef(id).width, 24, 400)),
      };
      const bg = optColor(c.bg);
      const fg = optColor(c.fg);
      const accent = optColor(c.accent);
      if (bg) cfg.bg = bg;
      if (fg) cfg.fg = fg;
      if (accent) cfg.accent = accent;
      columns.push(cfg);
    }
  }
  for (const id of COLUMN_IDS)
    if (!seen.has(id)) columns.push({ id, visible: false, width: columnDef(id).width });
  if (!columns.some((c) => c.visible)) columns.find((c) => c.id === 'price')!.visible = true;

  const s = isObj(r.style) ? r.style : {};
  const p = isObj(s.palette) ? s.palette : {};
  const bp = base.style.palette;
  const palette = Object.fromEntries(
    (Object.keys(bp) as (keyof DomPaletteSpec)[]).map((k) => [k, color(p[k], bp[k])]),
  ) as unknown as DomPaletteSpec;
  const centring: CentringMode = ['auto', 'always', 'manual'].includes(s.centring as string)
    ? (s.centring as CentringMode)
    : 'auto';
  const style: DomStyle = {
    fontFamily: str(s.fontFamily, BASE_STYLE.fontFamily, 80),
    fontSize: Math.round(num(s.fontSize, BASE_STYLE.fontSize, 8, 20)),
    rowHeight: Math.round(num(s.rowHeight, BASE_STYLE.rowHeight, 12, 40)),
    headerHeight: Math.round(num(s.headerHeight, BASE_STYLE.headerHeight, 14, 40)),
    centring,
    centreBand: num(s.centreBand, BASE_STYLE.centreBand, 0.05, 0.45),
    gridLines: s.gridLines === true,
    palette,
  };

  const b = isObj(r.behaviour) ? r.behaviour : {};
  const d = DEFAULT_BEHAVIOUR;
  const presets = Array.isArray(b.lotPresets)
    ? b.lotPresets
        .filter((x): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0)
        .slice(0, 8)
    : [];
  const behaviour: DomBehaviour = {
    volumeScope: b.volumeScope === 'range' ? 'range' : 'session',
    rangeMinutes: Math.round(num(b.rangeMinutes, d.rangeMinutes, 1, 1440)),
    recentSeconds: Math.round(num(b.recentSeconds, d.recentSeconds, 1, 600)),
    limitSeconds: Math.round(num(b.limitSeconds, d.limitSeconds, 1, 600)),
    pulledThreshold: num(b.pulledThreshold, d.pulledThreshold, 0, 1e9),
    stackedThreshold: num(b.stackedThreshold, d.stackedThreshold, 0, 1e9),
    flashMs: Math.round(num(b.flashMs, d.flashMs, 100, 10_000)),
    icebergMinRefills: Math.round(num(b.icebergMinRefills, d.icebergMinRefills, 1, 50)),
    bigSize: num(b.bigSize, d.bigSize, 0, 1e12),
    lotPresets: presets.length ? presets : [...d.lotPresets],
    showRiskLimits: b.showRiskLimits === true,
  };
  const id = typeof r.id === 'string' && /^[\w.-]{1,64}$/.test(r.id) ? r.id : fallbackId;
  return {
    version: 1,
    id,
    name: str(r.name, base.name),
    builtin: Boolean(builtinTemplate(id)) && r.builtin !== false,
    columns,
    style,
    behaviour,
  };
}

/** Export format: one template or a list, with a format tag. */
export interface DomTemplateFile {
  format: 'htflow.dom-templates';
  version: 1;
  templates: DomTemplate[];
}

export function serializeTemplates(ts: DomTemplate[]): string {
  const f: DomTemplateFile = { format: 'htflow.dom-templates', version: 1, templates: ts };
  return JSON.stringify(f, null, 2);
}

/**
 * Parses an export file (or a bare template / array). Imported templates always become custom
 * templates with fresh ids, so they never overwrite a built-in or an existing template.
 */
export function parseTemplates(json: string, newId: () => string): DomTemplate[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('Not valid JSON');
  }
  const list =
    isObj(raw) && Array.isArray(raw.templates) ? raw.templates : Array.isArray(raw) ? raw : [raw];
  const out = list.filter(isObj).map((t) => {
    const s = sanitizeTemplate(t);
    return { ...s, id: newId(), builtin: false };
  });
  if (!out.length) throw new Error('No templates in file');
  return out;
}

// ------------------------------------------------------------------ edits (pure)

export function toggleColumn(t: DomTemplate, id: DomColumnId, visible?: boolean): DomTemplate {
  const columns = t.columns.map((c) =>
    c.id === id ? { ...c, visible: visible ?? !c.visible } : c,
  );
  if (!columns.some((c) => c.visible)) return t;
  return { ...t, columns };
}

/** Moves column `id` to the position of `before` (or to the end when `before` is null). */
export function moveColumn(
  t: DomTemplate,
  id: DomColumnId,
  before: DomColumnId | null,
): DomTemplate {
  if (id === before) return t;
  const col = t.columns.find((c) => c.id === id);
  if (!col) return t;
  const rest = t.columns.filter((c) => c.id !== id);
  const i = before ? rest.findIndex((c) => c.id === before) : rest.length;
  rest.splice(i < 0 ? rest.length : i, 0, col);
  return { ...t, columns: rest };
}

export function resizeColumn(t: DomTemplate, id: DomColumnId, width: number): DomTemplate {
  const w = Math.round(Math.min(400, Math.max(24, width)));
  return { ...t, columns: t.columns.map((c) => (c.id === id ? { ...c, width: w } : c)) };
}

export function setColumnColors(
  t: DomTemplate,
  id: DomColumnId,
  colors: Pick<DomColumnConfig, 'bg' | 'fg' | 'accent'>,
): DomTemplate {
  return {
    ...t,
    columns: t.columns.map((c) => {
      if (c.id !== id) return c;
      const n: DomColumnConfig = { id: c.id, visible: c.visible, width: c.width };
      const bg = 'bg' in colors ? colors.bg : c.bg;
      const fg = 'fg' in colors ? colors.fg : c.fg;
      const accent = 'accent' in colors ? colors.accent : c.accent;
      if (bg) n.bg = bg;
      if (fg) n.fg = fg;
      if (accent) n.accent = accent;
      return n;
    }),
  };
}

export function duplicateTemplate(t: DomTemplate, id: string, existing: string[]): DomTemplate {
  return { ...cloneTemplate(t), id, builtin: false, name: uniqueName(`${t.name} copy`, existing) };
}

export function uniqueName(name: string, existing: string[]): string {
  if (!existing.includes(name)) return name;
  for (let i = 2; ; i++) if (!existing.includes(`${name} ${i}`)) return `${name} ${i}`;
}
