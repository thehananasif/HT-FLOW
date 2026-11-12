import type { ChartPalette } from '@htflow/chart-engine';
import type { ChartWindowState } from '@htflow/workspace';

/** Extension id under which chart-type / template settings are saved (`state.ext[CT_EXT]`). */
export const CT_EXT = 'chart-types';

export type TpoProfileSplit = 'day' | 'session' | 'week' | '4h' | '1h';
export type MtfLayout = 'overlay' | 'side' | 'stacked';

export interface ChartTypeSettings {
  /** Colour overrides for every template / chart type ('' = theme colour). */
  colors: { up: string; down: string; highlight: string; text: string };
  tpo: {
    periodMin: number;
    split: TpoProfileSplit;
    valueAreaPct: number;
    ibPeriods: number;
    /** 0 = auto. */
    rowTicks: number;
    display: 'letters' | 'blocks';
    showValueArea: boolean;
    showPoc: boolean;
    showIb: boolean;
    showSingles: boolean;
    slotWidth: number;
  };
  mtf: {
    /** Extra timeframes (ms) shown with the chart's own timeframe; 1–3 entries (2–4 total). */
    tfs: number[];
    layout: MtfLayout;
    opacity: number;
  };
  volumeHistogram: {
    colorBy: 'volume' | 'delta';
    widthPct: number;
    showValues: boolean;
    highlightMax: boolean;
  };
  imbalance: { ratio: number; minVolume: number; stacked: number; extendZones: boolean };
  liquidity: { gradient: string; opacity: number; upperCut: number };
  orderFlowLight: { bigTrade: number; showCvd: boolean; showBubbles: boolean };
  cot: {
    commercials: boolean;
    nonCommercials: boolean;
    nonReportable: boolean;
    openInterest: boolean;
  };
  pnf: { style: 'glyphs' | 'boxes' };
  kagi: { yangWidth: number; yinWidth: number };
}

export const DEFAULT_CHART_TYPE_SETTINGS: ChartTypeSettings = {
  colors: { up: '', down: '', highlight: '', text: '' },
  tpo: {
    periodMin: 30,
    split: 'day',
    valueAreaPct: 70,
    ibPeriods: 2,
    rowTicks: 0,
    display: 'letters',
    showValueArea: true,
    showPoc: true,
    showIb: true,
    showSingles: true,
    slotWidth: 260,
  },
  mtf: { tfs: [900_000], layout: 'overlay', opacity: 18 },
  volumeHistogram: { colorBy: 'delta', widthPct: 90, showValues: true, highlightMax: true },
  imbalance: { ratio: 300, minVolume: 0, stacked: 3, extendZones: true },
  liquidity: { gradient: 'classic', opacity: 70, upperCut: 98 },
  orderFlowLight: { bigTrade: 5, showCvd: true, showBubbles: true },
  cot: { commercials: true, nonCommercials: true, nonReportable: true, openInterest: false },
  pnf: { style: 'glyphs' },
  kagi: { yangWidth: 3, yinWidth: 1 },
};

const num = (v: unknown, d: number, lo: number, hi: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const pick = <T extends string>(v: unknown, opts: readonly T[], d: T): T =>
  opts.includes(v as T) ? (v as T) : d;
const color = (v: unknown) => (typeof v === 'string' && /^#[0-9a-fA-F]{6,8}$/.test(v) ? v : '');
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

/** Validates saved settings (anything missing or invalid falls back to the default). */
export function sanitizeChartTypeSettings(raw: unknown): ChartTypeSettings {
  const r = obj(raw);
  const D = DEFAULT_CHART_TYPE_SETTINGS;
  const c = obj(r.colors);
  const t = obj(r.tpo);
  const m = obj(r.mtf);
  const vh = obj(r.volumeHistogram);
  const im = obj(r.imbalance);
  const lq = obj(r.liquidity);
  const of = obj(r.orderFlowLight);
  const cot = obj(r.cot);
  const pnf = obj(r.pnf);
  const kg = obj(r.kagi);
  const tfs = Array.isArray(m.tfs)
    ? m.tfs
        .filter((x): x is number => typeof x === 'number' && x >= 1000 && x <= 30 * 86_400_000)
        .slice(0, 3)
    : D.mtf.tfs;
  return {
    colors: {
      up: color(c.up),
      down: color(c.down),
      highlight: color(c.highlight),
      text: color(c.text),
    },
    tpo: {
      periodMin: num(t.periodMin, D.tpo.periodMin, 1, 240),
      split: pick(t.split, ['day', 'session', 'week', '4h', '1h'] as const, D.tpo.split),
      valueAreaPct: num(t.valueAreaPct, D.tpo.valueAreaPct, 10, 100),
      ibPeriods: num(t.ibPeriods, D.tpo.ibPeriods, 1, 12),
      rowTicks: num(t.rowTicks, D.tpo.rowTicks, 0, 10_000),
      display: pick(t.display, ['letters', 'blocks'] as const, D.tpo.display),
      showValueArea: bool(t.showValueArea, D.tpo.showValueArea),
      showPoc: bool(t.showPoc, D.tpo.showPoc),
      showIb: bool(t.showIb, D.tpo.showIb),
      showSingles: bool(t.showSingles, D.tpo.showSingles),
      slotWidth: num(t.slotWidth, D.tpo.slotWidth, 60, 1200),
    },
    mtf: {
      tfs: tfs.length ? tfs : D.mtf.tfs,
      layout: pick(m.layout, ['overlay', 'side', 'stacked'] as const, D.mtf.layout),
      opacity: num(m.opacity, D.mtf.opacity, 2, 80),
    },
    volumeHistogram: {
      colorBy: pick(vh.colorBy, ['volume', 'delta'] as const, D.volumeHistogram.colorBy),
      widthPct: num(vh.widthPct, D.volumeHistogram.widthPct, 20, 100),
      showValues: bool(vh.showValues, D.volumeHistogram.showValues),
      highlightMax: bool(vh.highlightMax, D.volumeHistogram.highlightMax),
    },
    imbalance: {
      ratio: num(im.ratio, D.imbalance.ratio, 101, 2000),
      minVolume: num(im.minVolume, D.imbalance.minVolume, 0, 1e9),
      stacked: num(im.stacked, D.imbalance.stacked, 2, 10),
      extendZones: bool(im.extendZones, D.imbalance.extendZones),
    },
    liquidity: {
      gradient: typeof lq.gradient === 'string' ? lq.gradient : D.liquidity.gradient,
      opacity: num(lq.opacity, D.liquidity.opacity, 5, 100),
      upperCut: num(lq.upperCut, D.liquidity.upperCut, 50, 100),
    },
    orderFlowLight: {
      bigTrade: num(of.bigTrade, D.orderFlowLight.bigTrade, 0, 1e9),
      showCvd: bool(of.showCvd, D.orderFlowLight.showCvd),
      showBubbles: bool(of.showBubbles, D.orderFlowLight.showBubbles),
    },
    cot: {
      commercials: bool(cot.commercials, D.cot.commercials),
      nonCommercials: bool(cot.nonCommercials, D.cot.nonCommercials),
      nonReportable: bool(cot.nonReportable, D.cot.nonReportable),
      openInterest: bool(cot.openInterest, D.cot.openInterest),
    },
    pnf: { style: pick(pnf.style, ['glyphs', 'boxes'] as const, D.pnf.style) },
    kagi: {
      yangWidth: num(kg.yangWidth, D.kagi.yangWidth, 1, 8),
      yinWidth: num(kg.yinWidth, D.kagi.yinWidth, 1, 8),
    },
  };
}

export function readChartTypeSettings(s: ChartWindowState): ChartTypeSettings {
  return sanitizeChartTypeSettings(s.ext?.[CT_EXT]);
}

/** Theme palette with the user's colour overrides applied. */
export function withColors(p: ChartPalette, c: ChartTypeSettings['colors']): ChartPalette {
  return {
    ...p,
    up: c.up || p.up,
    down: c.down || p.down,
    warning: c.highlight || p.warning,
    textPrimary: c.text || p.textPrimary,
  };
}
