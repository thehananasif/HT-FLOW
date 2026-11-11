/** Window + layout model for the Dashboard (P44 / P25 / P37). Pure data — the app applies it to dockview. */

export type LinkColor = 'none' | 'red' | 'green' | 'blue' | 'yellow' | 'purple';
export const LINK_COLORS: Record<LinkColor, string> = {
  none: '#5E5E5E',
  red: '#F04A5D',
  green: '#20C77A',
  blue: '#4FA3F7',
  yellow: '#E8B04B',
  purple: '#B07CF0',
};

export type ChartTemplateId = 'candles-vp' | 'footprint' | 'liquidity-map' | 'order-flow-dark';

export interface ChartTemplateDef {
  id: ChartTemplateId;
  label: string;
  /** Short label for header chips. */
  short: string;
}

export const CHART_TEMPLATES: ChartTemplateDef[] = [
  { id: 'candles-vp', label: 'Japanese Candlesticks with Volume Profile', short: 'Candles + VP' },
  { id: 'footprint', label: 'Footprint chart', short: 'Footprint' },
  { id: 'liquidity-map', label: 'Liquidity Map', short: 'Liquidity Map' },
  { id: 'order-flow-dark', label: 'Order Flow (Dark)', short: 'Order Flow (Dark)' },
];

/** Built-in templates still to be built (shown disabled in the template menu; see docs/FEATURES.md). */
export const PENDING_TEMPLATES = [
  'Order Flow (Light)',
  'Imbalance Chart',
  'TPO Chart',
  'On-Chart Liquidity Map',
  'Multi-timeframe Chart',
  'Volume Histogram',
  'COT Chart',
  'Delta Profile',
];

export interface ChartWindowState {
  kind: 'chart';
  instrumentId: string;
  template: ChartTemplateId;
  /** Bar type, e.g. { kind: 'time', ms: 300000 }. */
  timeframe:
    | { kind: 'time'; ms: number }
    | { kind: 'tick' | 'volume' | 'delta'; n: number }
    | { kind: 'range'; ticks: number };
  lots: number;
  link: LinkColor;
  footprintMode: string;
  /** Liquidity map column size. */
  heatColumnMs: 250 | 1000 | 5000;
  minLots: number;
  /** Extension data keyed by extension id (indicators, drawings, …) — saved with the workspace. */
  ext?: Record<string, unknown>;
}

export interface DomWindowState {
  kind: 'dom';
  instrumentId: string;
  lots: number;
  link: LinkColor;
  grouping: number;
  ext?: Record<string, unknown>;
}

export interface ModuleWindowState {
  kind: 'module';
  module: string;
  /** Module-specific saved state (filters, columns, selected tab, …). */
  params?: Record<string, unknown>;
}

export type WindowState = ChartWindowState | DomWindowState | ModuleWindowState;

export type Direction = 'right' | 'below' | 'left' | 'above' | 'within';

export interface PanelSpec {
  id: string;
  state: WindowState;
  position?: { ref: string; dir: Direction };
  /** Initial share of the reference split (0..1). */
  size?: number;
}

export type LayoutPresetId = 'dom-chart-panel' | 'grid' | 'one-plus-two' | 'split' | 'single';

export interface LayoutPreset {
  id: LayoutPresetId;
  label: string;
  tradingPanel: boolean;
  build(instrumentId: string): PanelSpec[];
}

export function chartState(
  instrumentId: string,
  template: ChartTemplateId,
  extra: Partial<ChartWindowState> = {},
): ChartWindowState {
  return {
    kind: 'chart',
    instrumentId,
    template,
    timeframe: { kind: 'time', ms: template === 'candles-vp' ? 60_000 : 300_000 },
    lots: 1,
    link: 'none',
    footprintMode: 'volume',
    heatColumnMs: 250,
    minLots: 1,
    ...extra,
  };
}

export function domState(
  instrumentId: string,
  extra: Partial<DomWindowState> = {},
): DomWindowState {
  return { kind: 'dom', instrumentId, lots: 1, link: 'none', grouping: 1, ...extra };
}

/** The five one-click presets (P44); everything stays editable by dragging splitters afterwards. */
export const LAYOUT_PRESETS: LayoutPreset[] = [
  {
    id: 'dom-chart-panel',
    label: 'DOM | Chart | Panel',
    tradingPanel: true,
    build: (i) => [
      { id: 'dom-1', state: domState(i, { link: 'blue' }) },
      {
        id: 'chart-1',
        state: chartState(i, 'footprint', { link: 'blue' }),
        position: { ref: 'dom-1', dir: 'right' },
        size: 0.7,
      },
    ],
  },
  {
    id: 'grid',
    label: 'Grid 2×2',
    tradingPanel: false,
    build: (i) => [
      { id: 'chart-1', state: chartState(i, 'candles-vp', { link: 'green' }) },
      {
        id: 'chart-2',
        state: chartState(i, 'footprint', { link: 'green' }),
        position: { ref: 'chart-1', dir: 'right' },
      },
      {
        id: 'chart-3',
        state: chartState(i, 'liquidity-map', { link: 'green' }),
        position: { ref: 'chart-1', dir: 'below' },
      },
      {
        id: 'chart-4',
        state: chartState(i, 'order-flow-dark', { link: 'green' }),
        position: { ref: 'chart-2', dir: 'below' },
      },
    ],
  },
  {
    id: 'one-plus-two',
    label: '1 + 2',
    tradingPanel: false,
    build: (i) => [
      { id: 'chart-1', state: chartState(i, 'footprint', { link: 'yellow' }) },
      {
        id: 'chart-2',
        state: chartState(i, 'liquidity-map', { link: 'yellow' }),
        position: { ref: 'chart-1', dir: 'right' },
        size: 0.4,
      },
      {
        id: 'chart-3',
        state: chartState(i, 'order-flow-dark', { link: 'yellow' }),
        position: { ref: 'chart-2', dir: 'below' },
      },
    ],
  },
  {
    id: 'split',
    label: 'Split',
    tradingPanel: false,
    build: (i) => [
      { id: 'chart-1', state: chartState(i, 'candles-vp') },
      {
        id: 'chart-2',
        state: chartState(i, 'footprint'),
        position: { ref: 'chart-1', dir: 'right' },
      },
    ],
  },
  {
    id: 'single',
    label: 'Single',
    tradingPanel: false,
    build: (i) => [{ id: 'chart-1', state: chartState(i, 'footprint') }],
  },
];

export interface WorkspaceTab {
  id: string;
  name: string;
  /** dockview toJSON() output. */
  layout: unknown;
  windows: Record<string, WindowState>;
  tradingPanel: boolean;
}

export interface WorkspaceDoc {
  version: 1;
  name: string;
  activeTab: string;
  tabs: WorkspaceTab[];
  savedAt: number;
}

export function windowTitle(s: WindowState, symbol: string): string {
  if (s.kind === 'chart')
    return `${symbol} ${CHART_TEMPLATES.find((t) => t.id === s.template)?.short ?? 'Chart'}`;
  if (s.kind === 'dom') return `${symbol} DOM`;
  return s.module;
}
