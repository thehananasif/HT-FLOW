/**
 * Global chart defaults (Settings → Chart / Footprint, P27) mapped onto per-chart settings keys.
 * A chart's effective settings = schema defaults ← global defaults ← the chart's own overrides.
 */
import type { StatRowKey } from '@htflow/chart-engine';
import { chartState, type ChartTemplateId, type ChartWindowState } from '@htflow/workspace';
import { getSetting } from '../../state/settings';
import type { ChartSettings, LineValue } from './schema';

const hexAlpha = (hex: string, pct: number): string => {
  if (!/^#[0-9a-f]{6}$/i.test(hex) || pct >= 100) return hex;
  const a = Math.round(Math.max(0, Math.min(100, pct)) * 2.55)
    .toString(16)
    .padStart(2, '0');
  return `${hex}${a}`.toUpperCase();
};

const dash = (v: string): LineValue['style'] =>
  v === 'dashed' ? 'dash' : v === 'dotted' || v === 'dot' ? 'dot' : 'solid';

/** Per-chart keys derived from the global Settings (only keys the user can change globally). */
export function globalChartDefaults(): ChartSettings {
  const g = <T>(k: string): T => getSetting(k as never) as T;
  const out: ChartSettings = {};
  try {
    const mode = g<string>('chart.defaultMode');
    out['main.displayMode'] =
      mode === 'hollow'
        ? 'transparent'
        : ['bars', 'line', 'area', 'candles'].includes(mode)
          ? mode
          : 'candles';
    out['candles.up'] = g<string>('chart.candleUp') ?? '';
    out['candles.down'] = g<string>('chart.candleDown') ?? '';
    const bgMode = g<string>('chart.bgMode');
    if (bgMode === 'gradient') {
      out['main.background'] = g<string>('chart.bgGradientTop') || '';
      out['main.background2'] = g<string>('chart.bgGradientBottom') || '';
    } else out['main.background'] = g<string>('chart.bgColor') || '';
    const gridOn = g<boolean>('chart.gridVisible') !== false;
    out['grid.horizontal'] = gridOn;
    out['grid.vertical'] = gridOn;
    const gridColor = g<string>('chart.gridColor') || '';
    out['grid.line'] = {
      color: gridColor ? hexAlpha(gridColor, g<number>('chart.gridOpacity') ?? 100) : '',
      style: dash(g<string>('chart.gridStyle')),
      width: 1,
    } satisfies LineValue;
    out['scales.side'] = g<string>('chart.axisSide') === 'left' ? 'left' : 'right';
    const ps = g<string>('chart.priceScaleMode');
    out['scales.mode'] = ps === 'log' ? 'log' : ps === 'percent' ? 'percent' : 'linear';
    out['scales.autoScale'] = g<boolean>('chart.autoScale') !== false;
    out['other.verticalOffset'] = g<number>('chart.scaleMarginPct') ?? 8;
    out['price.show'] = g<boolean>('chart.lastPriceLine') !== false;
    out['grid.sessionLines'] = g<boolean>('chart.sessionBreaks') !== false;
    out['crosshair.line'] = {
      color: g<string>('chart.crosshairColor') || '',
      style: dash(g<string>('chart.crosshairStyle') ?? 'dashed'),
      width: 1,
    } satisfies LineValue;
    out['main.legend'] = g<boolean>('chart.legend') !== false;
    out['marks.watermark'] = g<boolean>('chart.watermark') === true;
    out['fp.imbRate'] = g<number>('footprint.imbalanceRatio') ?? 300;
    out['fp.imbVolume'] = g<number>('footprint.imbalanceMinVolume') ?? 0;
    out['fp.imbStacked'] = g<number>('footprint.stackedImbalance') ?? 3;
    out['fp.imbAsk'] = g<string>('footprint.imbalanceBuyColor') || '';
    out['fp.imbBid'] = g<string>('footprint.imbalanceSellColor') || '';
    out['fp.poc'] = g<boolean>('footprint.showPoc') !== false;
    out['fp.pocBorder'] = g<string>('footprint.pocColor') || '';
    out['fp.vaPct'] = g<number>('common.vaPercent') ?? 70;
    // Chart: magnet → crosshair snap; status line → indicator values under the legend.
    out['crosshair.snap'] = (g<string>('chart.magnet') ?? 'off') !== 'off';
    out['other.indicatorValues'] = g<boolean>('chart.statusLine') !== false;
    // Footprint defaults.
    const cm = g<string>('footprint.colorMode');
    out['fp.colorMode'] = cm === 'delta' || cm === 'none' ? cm : 'volume';
    out['fp.cellOpacity'] = g<number>('footprint.cellOpacity') ?? 100;
    out['fp.fontSize'] = g<number>('footprint.fontSize') ?? 11;
    out['fp.minCellHeight'] = g<number>('footprint.minCellHeight') ?? 9;
    out['fp.vaShow'] = g<boolean>('footprint.showValueArea') === true;
    out['fp.absorption'] = g<boolean>('footprint.absorptionMarkers') === true;
  } catch {
    // Settings store not ready (tests) → schema defaults.
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/** Candle wick / border colours (Settings → Chart; '' follows the body colour). */
export function globalCandleColors(): {
  wickUp: string;
  wickDown: string;
  borderUp: string;
  borderDown: string;
} {
  const g = (k: string): string => {
    try {
      const v = getSetting(k as never) as unknown;
      return typeof v === 'string' ? v : '';
    } catch {
      return '';
    }
  };
  return {
    wickUp: g('chart.wickUp'),
    wickDown: g('chart.wickDown'),
    borderUp: g('chart.borderUp'),
    borderDown: g('chart.borderDown'),
  };
}

const TF_MS: Record<string, number> = {
  '15s': 15_000,
  '30s': 30_000,
  '1m': 60_000,
  '2m': 120_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

/** Settings → Footprint "Cell content" → the footprint mode of new charts. */
export const CELL_MODE_TO_FOOTPRINT: Record<string, string> = {
  bidAsk: 'bidask',
  delta: 'delta',
  volume: 'volume',
  volumeDelta: 'volume-x-delta',
};

/** Defaults of a newly opened chart window from Settings (timeframe, footprint cell content). */
export function newChartDefaults(
  timeframe: string,
  cellMode: string,
): { timeframe: { kind: 'time'; ms: number }; footprintMode: string } {
  return {
    timeframe: { kind: 'time', ms: TF_MS[timeframe] ?? 300_000 },
    footprintMode: CELL_MODE_TO_FOOTPRINT[cellMode] ?? 'bidask',
  };
}

/** A new chart window with Settings → Chart default timeframe and Footprint cell content. */
export function newChartState(instrumentId: string, template: ChartTemplateId): ChartWindowState {
  const base = chartState(instrumentId, template);
  try {
    const d = newChartDefaults(
      String(getSetting('chart.defaultTimeframe')),
      String(getSetting('footprint.cellMode')),
    );
    return { ...base, ...d };
  } catch {
    return base;
  }
}

/** Footprint statistics rows from Settings → Footprint (delta / volume / cumulative delta). */
export function footprintStatRows(
  showDelta: boolean,
  showVolume: boolean,
  showCumDelta: boolean,
): StatRowKey[] {
  const rows: StatRowKey[] = [];
  if (showDelta) rows.push('delta');
  rows.push('sessionDelta');
  if (showVolume) rows.push('volume');
  if (showCumDelta) rows.push('cumDelta');
  return rows;
}

/** Global numeric chart options that are not per-chart rows. */
export function globalChartOptions(): {
  barSpacing: number;
  rightMarginBars: number;
  maxCandles: number;
  autoScroll: boolean;
  crosshairLabels: boolean;
  statRows: StatRowKey[];
} {
  const g = (k: string, d: number) => {
    try {
      const v = getSetting(k as never) as unknown;
      return typeof v === 'number' && Number.isFinite(v) ? v : d;
    } catch {
      return d;
    }
  };
  const flag = (k: string) => {
    try {
      return getSetting(k as never) !== false;
    } catch {
      return true;
    }
  };
  return {
    barSpacing: g('chart.barSpacing', 10),
    rightMarginBars: g('chart.rightMarginBars', 8),
    maxCandles: g('common.maxCandlesPerChart', 100_000),
    autoScroll: flag('chart.autoScroll'),
    crosshairLabels: flag('chart.crosshairLabels'),
    statRows: footprintStatRows(
      flag('footprint.showDeltaRow'),
      flag('footprint.showVolumeRow'),
      (() => {
        try {
          return getSetting('footprint.showCumDelta' as never) === true;
        } catch {
          return false;
        }
      })(),
    ),
  };
}
