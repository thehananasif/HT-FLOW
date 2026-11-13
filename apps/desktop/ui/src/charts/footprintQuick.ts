/**
 * Footprint quick settings (P10): the per-chart keys the quick dialog edits, and presets
 * (save / load / delete) that capture those keys plus the footprint mode.
 */
import { FOOTPRINT_MODES } from '@htflow/footprint';
import { ROW_BY_KEY, validateValue, type ChartSettings } from './settings/schema';

/** Per-chart settings rows covered by the quick dialog and by presets. */
export const QUICK_KEYS = [
  'fp.ticksPerRow',
  'other.autoTransformWidth',
  'fp.poc',
  'fp.imbalance',
  'fp.imbDirection',
  'fp.imbRate',
  'fp.imbVolume',
  'fp.imbStacked',
  'fp.minVolume',
  'fp.minDelta',
  'fp.vaShow',
  'fp.vaPct',
  'fp.vaColor',
  'fp.bidColor',
  'fp.askColor',
  'fp.textColor',
  'fp.pocBorder',
  'fp.imbAsk',
  'fp.imbBid',
] as const;

export type QuickKey = (typeof QUICK_KEYS)[number];

export interface FootprintPreset {
  id: string;
  name: string;
  /** Footprint mode id (window state). */
  mode: string;
  values: Partial<Record<QuickKey, unknown>>;
  /** Built-in presets cannot be deleted or overwritten. */
  builtin?: boolean;
}

const MODE_IDS = new Set(FOOTPRINT_MODES.map((m) => m.id));

/** Validated values of the quick keys only (unknown keys and invalid values are dropped). */
export function cleanValues(raw: unknown): Partial<Record<QuickKey, unknown>> {
  const out: Partial<Record<QuickKey, unknown>> = {};
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  for (const k of QUICK_KEYS) {
    const row = ROW_BY_KEY.get(k);
    if (!row || !(k in r)) continue;
    const v = validateValue(row, r[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** A preset from a chart's current settings and mode. */
export function presetFromSettings(
  name: string,
  mode: string,
  s: ChartSettings,
  id = `fp-${Date.now().toString(36)}`,
): FootprintPreset {
  return {
    id,
    name: name.trim() || 'Preset',
    mode: MODE_IDS.has(mode) ? mode : 'bidask',
    values: cleanValues(s),
  };
}

/** The chart settings after loading a preset (only the quick keys change). */
export function applyPresetValues(s: ChartSettings, p: FootprintPreset): ChartSettings {
  return { ...s, ...cleanValues(p.values) };
}

export const BUILTIN_PRESETS: FootprintPreset[] = [
  {
    id: 'builtin:imbalance',
    name: 'Imbalance hunter',
    mode: 'bidask',
    builtin: true,
    values: {
      'fp.imbalance': true,
      'fp.imbDirection': 'diagonal',
      'fp.imbRate': 300,
      'fp.imbStacked': 3,
      'fp.vaShow': false,
      'fp.minVolume': 0,
    },
  },
  {
    id: 'builtin:value-area',
    name: 'Value area per bar',
    mode: 'volume',
    builtin: true,
    values: { 'fp.vaShow': true, 'fp.vaPct': 70, 'fp.poc': true, 'fp.imbalance': false },
  },
  {
    id: 'builtin:big-only',
    name: 'Big clusters only',
    mode: 'bidask-delta-colored',
    builtin: true,
    values: {
      'fp.minVolume': 50,
      'fp.imbDirection': 'horizontal',
      'fp.imbRate': 250,
      'fp.vaShow': false,
    },
  },
];

/** Validates stored user presets (built-ins are never stored). */
export function normalizePresets(raw: unknown): FootprintPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: FootprintPreset[] = [];
  const seen = new Set<string>();
  for (const x of raw.slice(0, 100)) {
    if (!x || typeof x !== 'object') continue;
    const r = x as Partial<FootprintPreset>;
    if (typeof r.id !== 'string' || !r.id || r.id.startsWith('builtin:') || seen.has(r.id))
      continue;
    if (typeof r.name !== 'string' || !r.name.trim()) continue;
    seen.add(r.id);
    out.push({
      id: r.id,
      name: r.name.trim().slice(0, 60),
      mode: typeof r.mode === 'string' && MODE_IDS.has(r.mode) ? r.mode : 'bidask',
      values: cleanValues(r.values),
    });
  }
  return out;
}

/** Saves (or overwrites by name) a user preset; returns the new list. */
export function savePreset(list: FootprintPreset[], p: FootprintPreset): FootprintPreset[] {
  const i = list.findIndex((x) => x.name.toLowerCase() === p.name.toLowerCase());
  if (i < 0) return [...list, p];
  const next = [...list];
  next[i] = { ...p, id: list[i]!.id };
  return next;
}

export function deletePreset(list: FootprintPreset[], id: string): FootprintPreset[] {
  return list.filter((p) => p.id !== id);
}
