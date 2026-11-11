/**
 * Built-in style presets (P09): White, Light, Dark, Black, Dark footprint, Footprint statistic,
 * Imbalance, MarketResearch, MultiTimeFrame and default. They are read-only templates; "Duplicate"
 * makes an editable copy. Colour stays for market meaning only (up green, down red).
 */
import type { ChartSettings } from './settings/schema';
import type { ChartTemplateState, UserChartTemplate } from './templates';

const UP = '#20C77A';
const DOWN = '#F04A5D';

function preset(
  id: string,
  name: string,
  state: Partial<ChartTemplateState> & { settings: ChartSettings },
): UserChartTemplate {
  return {
    kind: 'htflow.chart-template',
    version: 1,
    id: `preset:${id}`,
    name,
    favourite: false,
    preset: true,
    createdAt: 0,
    updatedAt: 0,
    state: {
      template: 'candles-vp',
      footprintMode: 'volume',
      heatColumnMs: 250,
      minLots: 1,
      ...state,
    },
  };
}

const light = (bg: string, grid: string, text: string, axis: string): ChartSettings => ({
  'main.background': bg,
  'grid.line': { color: grid, style: 'solid', width: 1 },
  'axis.bg': axis,
  'axis.text': text,
  'crosshair.line': { color: '#7A7A7A', style: 'dash', width: 1 },
  'crosshair.labelBg': '#2A2A2A',
  'crosshair.labelText': '#FFFFFF',
  'candles.up': '#14A86A',
  'candles.down': '#D93A4E',
  'main.ohlcColor': '#333333',
});

export const STYLE_PRESETS: UserChartTemplate[] = [
  preset('default', 'default', { settings: {} }),
  preset('white', 'White', {
    settings: light('#FFFFFF', '#EEEEEE', '#4A4A4A', '#FFFFFF'),
  }),
  preset('light', 'Light', {
    settings: light('#F4F4F2', '#E2E2DF', '#555555', '#ECECEA'),
  }),
  preset('dark', 'Dark', {
    settings: {
      'main.background': '#141414',
      'grid.line': { color: '#222222', style: 'dash', width: 1 },
      'axis.bg': '#141414',
      'axis.text': '#9A9A9A',
      'candles.up': UP,
      'candles.down': DOWN,
    },
  }),
  preset('black', 'Black', {
    settings: {
      'main.background': '#000000',
      'main.background2': '#0B0B0B',
      'grid.line': { color: '#161616', style: 'solid', width: 1 },
      'axis.bg': '#000000',
      'axis.text': '#8C8C8C',
      'candles.up': UP,
      'candles.down': DOWN,
    },
  }),
  preset('dark-footprint', 'Dark footprint', {
    template: 'footprint',
    timeframe: { kind: 'time', ms: 300_000 },
    footprintMode: 'bidask',
    settings: {
      'main.background': '#0B0B0B',
      'grid.horizontal': false,
      'fp.bidColor': DOWN,
      'fp.askColor': UP,
      'fp.poc': true,
      'fp.imbalance': true,
    },
  }),
  preset('footprint-statistic', 'Footprint statistic', {
    template: 'footprint',
    timeframe: { kind: 'time', ms: 300_000 },
    footprintMode: 'volume',
    settings: {
      'crosshair.dataWindow': true,
      'main.barChange': true,
      'marks.highLow': true,
    },
  }),
  preset('imbalance', 'Imbalance', {
    template: 'footprint',
    timeframe: { kind: 'time', ms: 300_000 },
    footprintMode: 'bidask',
    settings: {
      'fp.imbalance': true,
      'fp.imbRate': 250,
      'fp.imbStacked': 3,
      'fp.imbBold': true,
    },
  }),
  preset('market-research', 'MarketResearch', {
    timeframe: { kind: 'time', ms: 3_600_000 },
    settings: {
      'scales.mode': 'log',
      'marks.highLow': true,
      'marks.watermark': true,
      'main.barChange': true,
      'crosshair.sync': 'link',
    },
  }),
  preset('multi-timeframe', 'MultiTimeFrame', {
    timeframe: { kind: 'time', ms: 900_000 },
    settings: {
      'marks.watermark': true,
      'grid.sessionShade': true,
      'crosshair.sync': 'global',
      'scales.gaps': true,
    },
  }),
];
