import { DEFAULT_HEATMAP, GRADIENTS, type HeatmapSettings } from '@htflow/heatmap';
import { getSettings, type SettingsValues } from '../../state/settings';

/** Everything a Heatmap window can customise (layer settings + window chrome). */
export interface HeatmapModuleSettings extends HeatmapSettings {
  /** Price axis on the right. */
  priceAxis: boolean;
  priceAxisWidth: number;
  timeAxis: boolean;
  grid: boolean;
  /** 3D surface height (0.2..3). */
  surfaceHeight: number;
  /** 3D grid resolution (columns). */
  surfaceCols: number;
  /** three.js (WebGL) or the Canvas2D isometric fallback. */
  renderer3d: 'webgl' | 'canvas';
}

export const COLUMN_WIDTHS = [250, 500, 1000, 2000, 5000] as const;
export type ColumnMs = (typeof COLUMN_WIDTHS)[number];

export interface Camera {
  yaw: number;
  pitch: number;
  dist: number;
}

export const DEFAULT_CAMERA: Camera = { yaw: -0.6, pitch: 0.62, dist: 3.1 };

export interface HeatmapParams {
  /** null = follow the active window's instrument. */
  instrumentId: string | null;
  columnMs: ColumnMs;
  /** Only values that differ from the global Settings → Heatmap defaults. */
  overrides: Partial<HeatmapModuleSettings>;
  mode3d: boolean;
  camera: Camera;
  /** Saved custom gradients (name → stops). */
  savedGradients: Record<string, { pos: number; color: string }[]>;
  /** Drawings on this window (serialised @htflow/drawings doc). */
  drawings: unknown;
}

const SETTINGS_PALETTE: Record<string, string> = {
  thermal: 'thermal',
  mono: 'mono',
  'blue-red': 'blue-red',
  viridis: 'viridis',
};

/**
 * Defaults of a new Heatmap window: the module defaults overlaid with Settings → Heatmap (and the
 * Heatmap rendering group of Common settings).
 */
export function baseSettings(g: SettingsValues = getSettings()): HeatmapModuleSettings {
  return {
    ...DEFAULT_HEATMAP,
    gradient: SETTINGS_PALETTE[g['heatmap.palette']] ?? 'thermal',
    contrast: g['heatmap.contrast'],
    opacity: g['heatmap.opacity'],
    scope: g['heatmap.normalization'] === 'session' ? 'session' : 'visible',
    minSize: g['heatmap.minSize'],
    smoothing: g['heatmap.smoothing'],
    historyMinutes: g['heatmap.historyMinutes'],
    bestBidAsk: g['heatmap.showBestBidAsk'],
    bubbles: g['heatmap.showTradeBubbles'],
    // Settings uses 25..400 %; the quick-settings Size slider is 1..100 (100 % = 25).
    bubbleScale: clamp(Math.round(g['heatmap.bubbleScale'] / 4), 1, 100),
    minLots: g['heatmap.bubbleMinSize'],
    volumeProfile: g['heatmap.showVolumeProfile'],
    rangeLevels: g['common.heatmapStartupLevels'],
    levelsLimit: g['common.domHeatmapLevels'],
    bbaMode: 'bid-ask',
    bbaExtend: true,
    bubbleStyle: 'pie',
    clustering: 3,
    volume: true,
    priceAxis: true,
    priceAxisWidth: 64,
    timeAxis: true,
    grid: true,
    surfaceHeight: 1,
    surfaceCols: 160,
    renderer3d: 'webgl',
  };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Numeric ranges (validation for overrides, inputs and imports). */
export const RANGES: Partial<Record<keyof HeatmapModuleSettings, [number, number, number]>> = {
  brightness: [0, 100, 1],
  contrast: [0, 100, 1],
  gamma: [0.2, 5, 0.05],
  opacity: [10, 100, 1],
  cutoffUpper: [1, 100, 1],
  cutoffLower: [0, 99, 1],
  minSize: [0, 1_000_000, 1],
  minLots: [0, 1_000_000, 1],
  bubbleScale: [1, 100, 1],
  clustering: [0, 10, 0.5],
  bubbleOpacity: [10, 100, 5],
  bbaWidth: [1, 6, 1],
  domWidth: [60, 400, 10],
  volumeHeight: [24, 300, 2],
  largeOrderSize: [1, 1_000_000, 1],
  lifetimeMaxSec: [5, 3600, 5],
  icebergRatio: [1.1, 20, 0.1],
  spoofMinSize: [0, 1_000_000, 1],
  spoofMaxLifeSec: [1, 120, 1],
  historyMinutes: [0, 1440, 5],
  rangeLevels: [0, 1000, 10],
  levelsLimit: [0, 1000, 1],
  priceAxisWidth: [40, 140, 2],
  surfaceHeight: [0.2, 3, 0.1],
  surfaceCols: [40, 400, 10],
};

const ENUMS: Partial<Record<keyof HeatmapModuleSettings, readonly string[]>> = {
  scale: ['linear', 'log', 'sqrt'],
  normalize: ['global', 'column'],
  scope: ['visible', 'session'],
  bubbleCalc: ['volume', 'delta'],
  bubbleStyle: ['plain', 'pie', 'dominant'],
  bbaMode: ['bid-ask', 'mid'],
  volumeCalc: ['volume', 'delta'],
  renderer3d: ['webgl', 'canvas'],
};

const HEX = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
const COLOR_KEYS = new Set<keyof HeatmapModuleSettings>([
  'buyColor',
  'sellColor',
  'plainColor',
  'bidColor',
  'askColor',
  'largeOrderColor',
  'lifetimeYoung',
  'lifetimeOld',
  'icebergColor',
  'spoofColor',
]);
/** Colours that may be '' (follow the theme). */
const THEME_COLORS = new Set<keyof HeatmapModuleSettings>([
  'buyColor',
  'sellColor',
  'bidColor',
  'askColor',
]);

/** Validates one value; returns the cleaned value or undefined when invalid. */
export function validateValue<K extends keyof HeatmapModuleSettings>(
  key: K,
  value: unknown,
  base: HeatmapModuleSettings,
): HeatmapModuleSettings[K] | undefined {
  const def = base[key];
  if (key === 'gradient') {
    return typeof value === 'string' && (value === 'custom' || value in GRADIENTS)
      ? (value as HeatmapModuleSettings[K])
      : undefined;
  }
  if (key === 'customStops') {
    if (!Array.isArray(value) || value.length < 2 || value.length > 16) return undefined;
    const stops = value
      .filter(
        (s): s is { pos: number; color: string } =>
          !!s &&
          typeof (s as { pos: unknown }).pos === 'number' &&
          typeof (s as { color: unknown }).color === 'string' &&
          HEX.test((s as { color: string }).color),
      )
      .map((s) => ({ pos: clamp(s.pos, 0, 1), color: s.color }));
    return stops.length >= 2 ? (stops as HeatmapModuleSettings[K]) : undefined;
  }
  if (COLOR_KEYS.has(key)) {
    if (typeof value !== 'string') return undefined;
    if (value === '' && THEME_COLORS.has(key)) return value as HeatmapModuleSettings[K];
    return HEX.test(value) ? (value as HeatmapModuleSettings[K]) : undefined;
  }
  const en = ENUMS[key];
  if (en) return typeof value === 'string' && en.includes(value) ? (value as never) : undefined;
  if (typeof def === 'boolean') return typeof value === 'boolean' ? (value as never) : undefined;
  if (typeof def === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    const r = RANGES[key];
    return (r ? clamp(value, r[0], r[1]) : value) as HeatmapModuleSettings[K];
  }
  return undefined;
}

/** Cleans stored overrides (drops unknown / invalid keys). */
export function sanitizeOverrides(
  raw: unknown,
  base: HeatmapModuleSettings,
): Partial<HeatmapModuleSettings> {
  const out: Partial<HeatmapModuleSettings> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(k in base)) continue;
    const key = k as keyof HeatmapModuleSettings;
    const val = validateValue(key, v, base);
    if (val !== undefined) (out as Record<string, unknown>)[key] = val;
  }
  // Keep lower < upper.
  const lo = out.cutoffLower ?? base.cutoffLower;
  const hi = out.cutoffUpper ?? base.cutoffUpper;
  if (lo >= hi) out.cutoffLower = Math.max(0, hi - 1);
  return out;
}

export function readParams(raw: Record<string, unknown> | undefined): HeatmapParams {
  const r = raw ?? {};
  const cam = (r.camera ?? {}) as Partial<Camera>;
  const num = (v: unknown, d: number, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : d;
  const saved: HeatmapParams['savedGradients'] = {};
  if (r.savedGradients && typeof r.savedGradients === 'object') {
    for (const [name, stops] of Object.entries(r.savedGradients as Record<string, unknown>)) {
      const v = validateValue('customStops', stops, baseSettings());
      if (v && name.length <= 40) saved[name] = v;
    }
  }
  return {
    instrumentId: typeof r.instrumentId === 'string' ? r.instrumentId : null,
    columnMs: (COLUMN_WIDTHS as readonly number[]).includes(r.columnMs as number)
      ? (r.columnMs as ColumnMs)
      : 250,
    overrides: (r.overrides && typeof r.overrides === 'object'
      ? r.overrides
      : {}) as Partial<HeatmapModuleSettings>,
    mode3d: r.mode3d === true,
    camera: {
      yaw: num(cam.yaw, DEFAULT_CAMERA.yaw, -Math.PI * 4, Math.PI * 4),
      pitch: num(cam.pitch, DEFAULT_CAMERA.pitch, 0.05, 1.5),
      dist: num(cam.dist, DEFAULT_CAMERA.dist, 1, 8),
    },
    savedGradients: saved,
    drawings: r.drawings ?? null,
  };
}

/** Effective settings of a window. */
export function effectiveSettings(
  p: HeatmapParams,
  base: HeatmapModuleSettings = baseSettings(),
): HeatmapModuleSettings {
  return { ...base, ...sanitizeOverrides(p.overrides, base) };
}

/** New overrides after setting `patch` (values equal to the base are dropped). */
export function nextOverrides(
  cur: Partial<HeatmapModuleSettings>,
  patch: Partial<HeatmapModuleSettings>,
  base: HeatmapModuleSettings,
): Partial<HeatmapModuleSettings> {
  const out: Record<string, unknown> = { ...cur };
  for (const [k, v] of Object.entries(patch)) {
    const key = k as keyof HeatmapModuleSettings;
    const val = validateValue(key, v, base);
    if (val === undefined) continue;
    if (JSON.stringify(val) === JSON.stringify(base[key])) delete out[key];
    else out[key] = val;
  }
  return sanitizeOverrides(out, base);
}

export function columnLabel(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${ms / 1000} s`;
}
