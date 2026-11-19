import { create } from 'zustand';
import { specKey, TIMEFRAME_PRESETS, type BarKind, type BarSpec } from '@htflow/market-data';
import { backend } from '../../backend';

/** One row of the timeframe dialog (P07): a bar type and its preset chips. */
export interface TfRow {
  row: string;
  kind: BarKind;
  specs: BarSpec[];
}

export interface ParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  def: number;
  /** For `ms` params: the unit shown in the editor (ms per unit). */
  unitMs?: number;
}

/** Editable parameters per bar type (Configure → add a custom chip). */
export function paramsFor(row: TfRow): ParamDef[] {
  const unit = row.row === 'Seconds' ? 1000 : 60_000;
  const unitLabel = unit === 1000 ? 'Seconds' : 'Minutes';
  switch (row.kind) {
    case 'time':
    case 'heikin':
      return [{ key: 'ms', label: unitLabel, min: 1, max: 60 * 24 * 31, def: 3, unitMs: unit }];
    case 'tick':
    case 'volume':
    case 'delta':
      return [{ key: 'n', label: 'Size', min: 1, max: 1e9, def: 100 }];
    case 'orderflow':
      return [{ key: 'n', label: 'Side changes', min: 1, max: 100, def: 1 }];
    case 'range':
    case 'rangex':
    case 'rangez':
      return [{ key: 'ticks', label: 'Ticks', min: 1, max: 10_000, def: 10 }];
    case 'rangexv':
      return [
        { key: 'ticks', label: 'Ticks', min: 1, max: 10_000, def: 10 },
        { key: 'vol', label: 'Min volume', min: 0, max: 1e9, def: 100 },
      ];
    case 'rangeus':
      return [
        { key: 'offset', label: 'Open offset', min: 0, max: 1000, def: 0 },
        { key: 'trend', label: 'Trend', min: 1, max: 1000, def: 2 },
        { key: 'reversal', label: 'Reversal', min: 1, max: 1000, def: 6 },
      ];
    case 'renko':
      return [{ key: 'box', label: 'Brick (ticks)', min: 1, max: 10_000, def: 8 }];
    case 'reversal':
      return [
        { key: 'size', label: 'Bar size', min: 1, max: 10_000, def: 12 },
        { key: 'rev', label: 'Reversal', min: 1, max: 10_000, def: 6 },
      ];
    case 'cumtrades':
      return [
        { key: 'min', label: 'From size', min: 0, max: 1e9, def: 10 },
        { key: 'max', label: 'To size (0 = ∞)', min: 0, max: 1e9, def: 0 },
      ];
    case 'pnf':
      return [
        { key: 'box', label: 'Box (ticks)', min: 1, max: 10_000, def: 4 },
        { key: 'reversal', label: 'Reversal (boxes)', min: 1, max: 20, def: 3 },
      ];
    case 'kagi':
      return [{ key: 'rev', label: 'Reversal (ticks)', min: 1, max: 10_000, def: 8 }];
    case 'linebreak':
      return [
        { key: 'lines', label: 'Lines', min: 1, max: 10, def: 3 },
        { key: 'ms', label: 'Period (minutes)', min: 1, max: 1440, def: 15, unitMs: 60_000 },
      ];
  }
}

/** Builds a spec from editor values (already in display units). */
export function specFromParams(row: TfRow, values: Record<string, number>): BarSpec {
  const out: Record<string, unknown> = { kind: row.kind };
  for (const p of paramsFor(row)) {
    const raw = values[p.key] ?? p.def;
    const v = Math.min(p.max, Math.max(p.min, Number.isFinite(raw) ? raw : p.def));
    out[p.key] = p.unitMs ? Math.round(v * p.unitMs) : v;
  }
  return out as unknown as BarSpec;
}

export const DEFAULT_PINNED: BarSpec[] = [
  { kind: 'time', ms: 60_000 },
  { kind: 'time', ms: 300_000 },
  { kind: 'time', ms: 3_600_000 },
];

export const sameSpec = (a: BarSpec, b: BarSpec) => specKey(a) === specKey(b);

const KINDS = new Set(TIMEFRAME_PRESETS.map((r) => r.kind));

function validSpec(x: unknown): x is BarSpec {
  if (!x || typeof x !== 'object') return false;
  const k = (x as { kind?: unknown }).kind;
  if (typeof k !== 'string' || !KINDS.has(k as BarKind)) return false;
  return Object.entries(x).every(
    ([key, v]) =>
      key === 'kind' ||
      key === 'session' ||
      (key === 'cal' ? v === 'month' : false) ||
      (key === 'wicks' ? typeof v === 'boolean' : typeof v === 'number' && Number.isFinite(v)),
  );
}

export function sanitizeRows(raw: unknown): TfRow[] {
  if (!Array.isArray(raw)) return defaultRows();
  const byRow = new Map<string, TfRow>();
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const { row, kind, specs } = r as Partial<TfRow>;
    if (typeof row !== 'string' || !KINDS.has(kind as BarKind) || !Array.isArray(specs)) continue;
    byRow.set(row, {
      row,
      kind: kind as BarKind,
      specs: specs.filter((s) => validSpec(s) && s.kind === kind),
    });
  }
  // rows added in later versions appear with their defaults
  return defaultRows().map((d) => byRow.get(d.row) ?? d);
}

export function sanitizePinned(raw: unknown): BarSpec[] {
  if (!Array.isArray(raw)) return DEFAULT_PINNED;
  return raw.filter(validSpec).slice(0, 12);
}

/** Bar kinds a custom interval can have (the "Add custom interval" units). */
const CUSTOM_KINDS = new Set<BarKind>(['time', 'tick', 'volume', 'range']);

/** Saved custom intervals: valid, unique, time / tick / volume / range only. */
export function sanitizeCustom(raw: unknown): BarSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: BarSpec[] = [];
  for (const x of raw) {
    if (!validSpec(x) || !CUSTOM_KINDS.has(x.kind) || out.some((o) => sameSpec(o, x))) continue;
    out.push(x);
  }
  return out.slice(0, 60);
}

export function sanitizeCollapsed(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((x): x is string => typeof x === 'string').slice(0, 60)
    : [];
}

export const defaultRows = (): TfRow[] =>
  TIMEFRAME_PRESETS.map((r) => ({ row: r.row, kind: r.kind, specs: r.specs.slice() }));

const KEY = 'chart-types.timeframes';

interface TfState {
  rows: TfRow[];
  pinned: BarSpec[];
  /** User-defined intervals ("Add custom interval"), saved to the profile. */
  custom: BarSpec[];
  /** Ids of the timeframe-menu groups that are collapsed. */
  collapsed: string[];
  loaded: boolean;
  load(): Promise<void>;
  addChip(row: string, spec: BarSpec): void;
  removeChip(row: string, spec: BarSpec): void;
  togglePin(spec: BarSpec): void;
  addCustom(spec: BarSpec): void;
  removeCustom(spec: BarSpec): void;
  toggleGroup(id: string): void;
  reset(): void;
}

/** User timeframe presets and pinned header chips — saved per user profile. */
export const useTimeframes = create<TfState>((set, get) => {
  const save = () => {
    const { rows, pinned, custom, collapsed } = get();
    void backend.saveSettings(KEY, { rows, pinned, custom, collapsed }).catch(() => {});
  };
  return {
    rows: defaultRows(),
    pinned: DEFAULT_PINNED,
    custom: [],
    collapsed: [],
    loaded: false,
    async load() {
      try {
        const v = await backend.loadSettings<{
          rows?: unknown;
          pinned?: unknown;
          custom?: unknown;
          collapsed?: unknown;
        }>(KEY);
        set({
          rows: sanitizeRows(v?.rows),
          pinned: sanitizePinned(v?.pinned),
          custom: sanitizeCustom(v?.custom),
          collapsed: sanitizeCollapsed(v?.collapsed),
          loaded: true,
        });
      } catch {
        set({ loaded: true });
      }
    },
    addChip(row, spec) {
      set({
        rows: get().rows.map((r) =>
          r.row === row && !r.specs.some((s) => sameSpec(s, spec))
            ? { ...r, specs: [...r.specs, spec] }
            : r,
        ),
      });
      save();
    },
    removeChip(row, spec) {
      set({
        rows: get().rows.map((r) =>
          r.row === row ? { ...r, specs: r.specs.filter((s) => !sameSpec(s, spec)) } : r,
        ),
        pinned: get().pinned.filter((p) => !sameSpec(p, spec)),
      });
      save();
    },
    togglePin(spec) {
      const p = get().pinned;
      set({
        pinned: p.some((x) => sameSpec(x, spec))
          ? p.filter((x) => !sameSpec(x, spec))
          : [...p, spec].slice(0, 12),
      });
      save();
    },
    addCustom(spec) {
      if (get().custom.some((c) => sameSpec(c, spec))) return;
      set({ custom: [...get().custom, spec] });
      save();
    },
    removeCustom(spec) {
      set({
        custom: get().custom.filter((c) => !sameSpec(c, spec)),
        pinned: get().pinned.filter((p) => !sameSpec(p, spec)),
      });
      save();
    },
    toggleGroup(id) {
      const c = get().collapsed;
      set({ collapsed: c.includes(id) ? c.filter((x) => x !== id) : [...c, id] });
      save();
    },
    reset() {
      set({ rows: defaultRows(), pinned: DEFAULT_PINNED, custom: [] });
      save();
    },
  };
});

/** Which chart window's timeframe dialog is open (null = closed). */
export const useTfDialog = create<{ windowId: string | null; configure: boolean }>(() => ({
  windowId: null,
  configure: false,
}));

export function openTimeframeDialog(windowId: string, configure = false): void {
  useTfDialog.setState({ windowId, configure });
}

/** Same bar type and parameters, ignoring the session. */
export const sameBase = (a: BarSpec, b: BarSpec) =>
  specKey({ ...a, session: undefined }) === specKey({ ...b, session: undefined });

/** A chip spec with the chart's current session kept. */
export function withSession(spec: BarSpec, session: BarSpec['session']): BarSpec {
  const { session: _drop, ...base } = spec;
  void _drop;
  return (session && session !== '24h' ? { ...base, session } : base) as BarSpec;
}
