/**
 * Global chart defaults (Settings → Chart / Footprint, P27) mapped onto per-chart settings keys.
 * A chart's effective settings = schema defaults ← global defaults ← the chart's own overrides.
 */
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
  } catch {
    // Settings store not ready (tests) → schema defaults.
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/** Global numeric chart options that are not per-chart rows. */
export function globalChartOptions(): {
  barSpacing: number;
  rightMarginBars: number;
  maxCandles: number;
} {
  const g = (k: string, d: number) => {
    try {
      const v = getSetting(k as never) as unknown;
      return typeof v === 'number' && Number.isFinite(v) ? v : d;
    } catch {
      return d;
    }
  };
  return {
    barSpacing: g('chart.barSpacing', 10),
    rightMarginBars: g('chart.rightMarginBars', 8),
    maxCandles: g('common.maxCandlesPerChart', 100_000),
  };
}
