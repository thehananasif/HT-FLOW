/** Window + layout model for the Dashboard (P44 / P25 / P37). Pure data — the app applies it to dockview. */

export type LinkColor = 'none' | 'red' | 'green' | 'blue' | 'yellow' | 'purple';
/** Default swatch of every link group (Layout settings can override each one). */
export const LINK_COLOR_DEFAULTS: Record<LinkColor, string> = {
  none: '#5E5E5E',
  red: '#F04A5D',
  green: '#20C77A',
  blue: '#4FA3F7',
  yellow: '#E8B04B',
  purple: '#B07CF0',
};
export const LINK_COLOR_IDS = Object.keys(LINK_COLOR_DEFAULTS) as LinkColor[];
/**
 * CSS colour of each link group: a `--ht-link-<colour>` custom property (set from Layout settings)
 * with the default as fallback, so every swatch follows the user's colours without re-rendering.
 */
export const LINK_COLORS: Record<LinkColor, string> = Object.fromEntries(
  LINK_COLOR_IDS.map((c) => [c, `var(--ht-link-${c}, ${LINK_COLOR_DEFAULTS[c]})`]),
) as Record<LinkColor, string>;

export type ChartTemplateId =
  | 'candles-vp'
  | 'footprint'
  | 'liquidity-map'
  | 'order-flow-dark'
  | 'order-flow-light'
  | 'imbalance'
  | 'tpo'
  | 'onchart-liquidity'
  | 'mtf'
  | 'volume-histogram'
  | 'cot'
  | 'delta-profile';

export interface ChartTemplateDef {
  id: ChartTemplateId;
  label: string;
  /** Short label for header chips. */
  short: string;
  /** Additional built-in template (template menu / palette only, not the toolbar's main chips). */
  more?: boolean;
}

export const CHART_TEMPLATES: ChartTemplateDef[] = [
  { id: 'candles-vp', label: 'Japanese Candlesticks with Volume Profile', short: 'Candles + VP' },
  { id: 'footprint', label: 'Footprint chart', short: 'Footprint' },
  { id: 'liquidity-map', label: 'Liquidity Map', short: 'Liquidity Map' },
  { id: 'order-flow-dark', label: 'Order Flow (Dark)', short: 'Order Flow (Dark)' },
  { id: 'order-flow-light', label: 'Order Flow (Light)', short: 'Order Flow (Light)', more: true },
  { id: 'imbalance', label: 'Imbalance Chart', short: 'Imbalance', more: true },
  { id: 'tpo', label: 'TPO Chart', short: 'TPO', more: true },
  {
    id: 'onchart-liquidity',
    label: 'On-Chart Liquidity Map',
    short: 'On-Chart Liquidity',
    more: true,
  },
  { id: 'mtf', label: 'Multi-timeframe Chart', short: 'Multi-timeframe', more: true },
  { id: 'volume-histogram', label: 'Volume Histogram', short: 'Volume Histogram', more: true },
  { id: 'cot', label: 'COT Chart', short: 'COT', more: true },
  { id: 'delta-profile', label: 'Delta Profile', short: 'Delta Profile', more: true },
];

/** Built-in templates still to be built (shown disabled in the template menu; see docs/FEATURES.md). */
export const PENDING_TEMPLATES: string[] = [];

/**
 * Bar type of a chart (structural copy of @htflow/market-data BarSpec: time, tick, volume, delta,
 * range, Range X / XV / Z / US, Renko, Reversal, Order Flow, Cumulative Trades, Heikin-Ashi, P&F,
 * Kagi, Line Break; optional `session`).
 */
export type TimeframeSpec = (
  | { kind: 'time'; ms: number; cal?: 'month' }
  | { kind: 'tick' | 'volume' | 'delta'; n: number }
  | { kind: 'range' | 'rangex' | 'rangez'; ticks: number }
  | { kind: 'rangexv'; ticks: number; vol: number }
  | { kind: 'rangeus'; trend: number; reversal: number; offset: number }
  | { kind: 'renko'; box: number; wicks?: boolean }
  | { kind: 'reversal'; size: number; rev: number }
  | { kind: 'orderflow'; n: number }
  | { kind: 'cumtrades'; min: number; max: number }
  | { kind: 'heikin'; ms: number }
  | { kind: 'pnf'; box: number; reversal: number }
  | { kind: 'kagi'; rev: number }
  | { kind: 'linebreak'; lines: number; ms: number }
) & {
  session?: 'rth' | 'eth' | '24h' | { open: string; close: string; tz?: string; days?: number[] };
};

export interface ChartWindowState {
  kind: 'chart';
  instrumentId: string;
  template: ChartTemplateId;
  /** Bar type, e.g. { kind: 'time', ms: 300000 }. */
  timeframe: TimeframeSpec;
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
  /**
   * How to build the tab when `layout` is null (starter workspaces, imported files without a
   * dockview layout). Each spec's state is also in `windows`.
   */
  specs?: PanelSpec[];
  /**
   * Windows shown in separate OS windows (desktop app). Their states are in `windows`; they are
   * not part of `layout`. The web build folds them back into floating windows.
   */
  osWindows?: OsWindowSpec[];
}

/** One separate OS window of a layout tab (a detached dock group or a workspace). */
export interface OsWindowSpec {
  /** Native window label (`ht-w-…`); its bounds and monitor are remembered per label. */
  label: string;
  title: string;
  kind: 'panels' | 'workspace';
  /** Window ids (keys of the tab's `windows`) shown in that OS window. */
  ids: string[];
  /** dockview layout inside the OS window. */
  layout?: unknown;
  /** Library workspace it was opened from (kind `workspace`). */
  workspaceId?: string;
}

export interface WorkspaceDoc {
  version: 1;
  name: string;
  activeTab: string;
  tabs: WorkspaceTab[];
  savedAt: number;
  /** Screen geometry when the workspace was saved (multi-monitor restore). */
  display?: DisplaySnapshot;
}

/** A rectangle in screen (or container) pixels. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MonitorInfo extends Rect {
  name: string;
  primary: boolean;
  scale: number;
}

/** Where the app and its floating windows were on screen when the workspace was saved. */
export interface DisplaySnapshot {
  monitors: MonitorInfo[];
  /** The main window, in screen pixels. */
  main: Rect;
  /** The docking area inside the main window (floating windows are positioned in it). */
  container: { width: number; height: number };
  /** Screen bounds of every floating / detached window, by window id. */
  windows: Record<string, Rect & { monitor: string }>;
}

export function windowTitle(s: WindowState, symbol: string): string {
  if (s.kind === 'chart')
    return `${symbol} ${CHART_TEMPLATES.find((t) => t.id === s.template)?.short ?? 'Chart'}`;
  if (s.kind === 'dom') return `${symbol} DOM`;
  return s.module;
}
