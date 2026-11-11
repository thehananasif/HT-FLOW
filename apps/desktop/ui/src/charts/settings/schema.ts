/**
 * Per-chart settings schema (P34 Chart settings window). Every row has a default, validation and
 * help text; values are stored per chart window (ChartWindowState.ext['chart-settings']) as the
 * keys that differ from the defaults, and templates carry the same map.
 */
import { FOOTPRINT_MODES } from '@htflow/footprint';

export type RowType =
  'color' | 'bool' | 'number' | 'enum' | 'slider' | 'line' | 'gradient' | 'time' | 'text' | 'rules';

export type LineDashName = 'solid' | 'dash' | 'dot';
export interface LineValue {
  color: string;
  style: LineDashName;
  width: number;
}

export interface FilterRule {
  field: 'volume' | 'delta' | 'trades' | 'bid' | 'ask';
  op: '>=' | '<=';
  value: number;
  color: string;
}

export interface RowDef {
  key: string;
  label: string;
  type: RowType;
  default: unknown;
  help?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  /** Child row (indented under the previous one). */
  indent?: boolean;
  /** Rows bound to window-state fields instead of the settings map. */
  bind?: 'footprintMode';
  /** Stored and exported for other modules (trading, drawings) rather than drawn by ChartCore. */
  consumer?: string;
}

export interface SectionDef {
  id: string;
  label: string;
  rows: RowDef[];
}

export type TabId = 'visual' | 'footprint' | 'trading' | 'templates';

export interface TabDef {
  id: TabId;
  label: string;
  sections: SectionDef[];
}

export type ChartSettings = Record<string, unknown>;

// ------------------------------------------------------------------ row helpers

const color = (
  key: string,
  label: string,
  def = '',
  help?: string,
  extra: Partial<RowDef> = {},
): RowDef => ({
  key,
  label,
  type: 'color',
  default: def,
  ...(help ? { help } : {}),
  ...extra,
});
const bool = (
  key: string,
  label: string,
  def: boolean,
  help?: string,
  extra: Partial<RowDef> = {},
): RowDef => ({
  key,
  label,
  type: 'bool',
  default: def,
  ...(help ? { help } : {}),
  ...extra,
});
const num = (
  key: string,
  label: string,
  def: number,
  min: number,
  max: number,
  help?: string,
  extra: Partial<RowDef> = {},
): RowDef => ({
  key,
  label,
  type: 'number',
  default: def,
  min,
  max,
  step: 1,
  ...(help ? { help } : {}),
  ...extra,
});
const slider = (
  key: string,
  label: string,
  def: number,
  min: number,
  max: number,
  help?: string,
  extra: Partial<RowDef> = {},
): RowDef => ({
  key,
  label,
  type: 'slider',
  default: def,
  min,
  max,
  step: 1,
  ...(help ? { help } : {}),
  ...extra,
});
const opts = (...pairs: [string, string][]) => pairs.map(([value, label]) => ({ value, label }));
const enm = (
  key: string,
  label: string,
  def: string,
  options: { value: string; label: string }[],
  help?: string,
  extra: Partial<RowDef> = {},
): RowDef => ({
  key,
  label,
  type: 'enum',
  default: def,
  options,
  ...(help ? { help } : {}),
  ...extra,
});
const line = (
  key: string,
  label: string,
  def: LineValue,
  help?: string,
  extra: Partial<RowDef> = {},
): RowDef => ({
  key,
  label,
  type: 'line',
  default: def,
  ...(help ? { help } : {}),
  ...extra,
});
const grad = (
  key: string,
  label: string,
  def: string,
  help?: string,
  extra: Partial<RowDef> = {},
): RowDef => ({
  key,
  label,
  type: 'gradient',
  default: def,
  ...(help ? { help } : {}),
  ...extra,
});

const VIS: ['visible', string][] = [['visible', 'Visible']];
const VISIBILITY = opts(...VIS, ['hidden', 'Hidden'], ['hover', 'On mouse over']);
const LINE_STYLES = opts(['solid', 'Solid'], ['dash', 'Dash'], ['dot', 'Dot']);

export const TIME_ZONES = opts(
  ['default', 'Default (Settings → Time zones)'],
  ['local', 'This computer'],
  ['UTC', 'UTC'],
  ['America/New_York', 'New York'],
  ['America/Chicago', 'Chicago'],
  ['America/Los_Angeles', 'Los Angeles'],
  ['Europe/London', 'London'],
  ['Europe/Berlin', 'Frankfurt'],
  ['Europe/Moscow', 'Moscow'],
  ['Asia/Dubai', 'Dubai'],
  ['Asia/Karachi', 'Karachi'],
  ['Asia/Kolkata', 'Mumbai'],
  ['Asia/Singapore', 'Singapore'],
  ['Asia/Hong_Kong', 'Hong Kong'],
  ['Asia/Tokyo', 'Tokyo'],
  ['Australia/Sydney', 'Sydney'],
);

export const DISPLAY_MODES = opts(
  ['candles', 'Candles'],
  ['bars', 'Bars'],
  ['transparent', 'Transparent candles'],
  ['line', 'Line chart'],
  ['area', 'Area'],
  ['hidden', 'Hidden'],
);

export const MOUSE_MODES = opts(
  ['pointer', 'Pointer'],
  ['crosshair', 'Crosshair'],
  ['zoom', 'Zoom'],
  ['scroll', 'Scroll'],
  ['zoomxy', 'ZoomXY'],
);

export const TRADING_SESSIONS = opts(
  ['24h', '24h'],
  ['eth', 'ETH (electronic, all hours)'],
  ['rth', 'RTH (09:30–16:00 New York)'],
  ['custom', 'Custom (Session time section)'],
);

// ------------------------------------------------------------------ tabs

export const TABS: TabDef[] = [
  {
    id: 'visual',
    label: 'Visual Settings',
    sections: [
      {
        id: 'main',
        label: 'Main',
        rows: [
          color(
            'main.background',
            'Background',
            '',
            'Chart background. One colour, or two colours as a vertical gradient (second colour below).',
          ),
          color(
            'main.background2',
            'Second background colour (gradient)',
            '',
            'Empty = one-colour background.',
            { indent: true },
          ),
          bool(
            'main.ohlcValues',
            'OHLC values',
            true,
            'Show open, high, low and close of the bar under the cursor in the legend.',
          ),
          color(
            'main.ohlcColor',
            'OHLC color',
            '',
            'Legend value colour when "OHLC by candle color" is off.',
          ),
          bool(
            'main.ohlcByCandle',
            'OHLC by candle color',
            true,
            'Colour legend values green / red by bar direction.',
          ),
          bool(
            'main.barChange',
            'Bar change values',
            false,
            'Show the change vs the previous close (points and %).',
          ),
          bool('main.legendTitle', 'Instrument title in legend', true),
          bool('main.legendVolume', 'Volume in legend', true),
          bool('main.legendDelta', 'Delta in legend', true),
          color(
            'main.indicatorLabelColor',
            'Indicator labels color',
            '',
            'Text colour of indicator labels in sub-panes.',
          ),
          color('main.indicatorLabelBg', 'Indicator labels background', '', 'Empty = transparent.'),
          line(
            'main.separators',
            'Indicator / pane separators',
            { color: '', style: 'solid', width: 1 },
            'Line between the price pane and sub-panes. Drag a separator to resize a pane; double-click it to reset.',
          ),
          enm(
            'main.candleDirection',
            'Candles direction mode',
            'close-open',
            opts(['close-open', 'Close vs Open'], ['close-prev', 'Close vs previous Close']),
            'How a bar is classified as up or down.',
          ),
          enm(
            'main.displayMode',
            'Display mode',
            'candles',
            DISPLAY_MODES,
            'Right-click → Mode. Footprint charts collapse to this mode when zoomed out.',
          ),
        ],
      },
      {
        id: 'scales',
        label: 'Scales',
        rows: [
          enm(
            'scales.mode',
            'Price scale',
            'linear',
            opts(
              ['linear', 'Linear'],
              ['log', 'Logarithmic'],
              ['percent', 'Percent'],
              ['indexed', 'Indexed to 100'],
            ),
            'Percent and indexed scales are relative to the first visible bar.',
          ),
          bool('scales.invert', 'Invert scale', false, 'High prices at the bottom.'),
          bool(
            'scales.autoScale',
            'Auto scale',
            true,
            'Fit the visible bars. Dragging the price axis turns it off; double-click the axis to turn it on.',
          ),
          enm(
            'scales.side',
            'Price axis',
            'right',
            opts(['right', 'Right'], ['left', 'Left'], ['both', 'Both']),
          ),
          bool(
            'scales.gaps',
            'Show time gaps',
            false,
            'Gaps on: x is proportional to time, so periods without trades leave empty space. Off: bars sit next to each other.',
          ),
          enm(
            'scales.timeZone',
            'Time zone',
            'default',
            TIME_ZONES,
            'Time zone of this chart’s time axis and crosshair label.',
          ),
          enm(
            'scales.timeFormat',
            'Time format',
            '24h',
            opts(['24h', '24-hour'], ['12h', '12-hour']),
          ),
        ],
      },
      {
        id: 'crosshair',
        label: 'Crosshair',
        rows: [
          enm(
            'crosshair.mouseMode',
            'Mouse mode',
            'crosshair',
            MOUSE_MODES,
            'Right-click → Mouse.',
          ),
          line('crosshair.line', 'Crosshair', { color: '', style: 'dash', width: 1 }),
          color('crosshair.labelBg', 'Label background'),
          color('crosshair.labelText', 'Label text'),
          bool(
            'crosshair.snap',
            'Snap crosshair to price',
            false,
            'The horizontal line snaps to the close of the bar under the cursor.',
          ),
          enm(
            'crosshair.sync',
            'Crosshair sync',
            'off',
            opts(
              ['off', 'Off'],
              ['link', 'Sync crosshair (link group)'],
              ['global', 'Global crosshair (all windows)'],
            ),
            'Show this chart’s crosshair on other charts: only the same link group, or every chart.',
          ),
          bool(
            'crosshair.dataWindow',
            'Data window',
            false,
            'Panel with OHLCV, delta and every layer value at the cursor.',
          ),
        ],
      },
      {
        id: 'delays',
        label: 'Data delays',
        rows: [
          color('delays.goodBg', 'Good background color', '#20C77A'),
          color('delays.goodText', 'Good text color', '#111111'),
          color('delays.warnBg', 'Warning background color', '#E8B04B'),
          color('delays.warnText', 'Warning text color', '#111111'),
          color('delays.critBg', 'Critical background color', '#F04A5D'),
          color('delays.critText', 'Critical text color', '#FFFFFF'),
          num('delays.warnMs', 'Warning above (ms)', 250, 10, 10_000),
          num('delays.critMs', 'Critical above (ms)', 1000, 50, 60_000),
          bool('delays.show', 'Show delay chip in the bottom bar', true),
          bool(
            'delays.test',
            'Test mode',
            false,
            'Cycles the chip through good / warning / critical to preview colours.',
          ),
        ],
      },
      {
        id: 'price',
        label: 'Current price',
        rows: [
          bool('price.show', 'Current price line', true),
          line(
            'price.line',
            'Line',
            { color: '', style: 'dash', width: 1 },
            'Empty colour = direction colour of the last trade.',
          ),
          bool(
            'price.extend',
            'Extend price line',
            true,
            'Draw the line across the whole pane (off = only right of the last bar).',
          ),
          bool('price.bidAsk', 'Best bid / ask lines', false),
          bool(
            'price.countdown',
            'Bar countdown timer',
            true,
            'Time to bar close under the price tag (time bars only).',
          ),
        ],
      },
      {
        id: 'grid',
        label: 'Grid',
        rows: [
          line('grid.line', 'Grid style', { color: '', style: 'dash', width: 1 }),
          bool('grid.horizontal', 'Horizontal grid', true),
          bool('grid.vertical', 'Vertical grid', true),
          enm(
            'grid.stepUnit',
            'Vertical grid step unit',
            'time',
            opts(['time', 'Time'], ['bars', 'Bars']),
          ),
          num(
            'grid.barStep',
            'Bars between vertical lines',
            10,
            1,
            500,
            'Used when the step unit is Bars.',
            { indent: true },
          ),
          bool('grid.sessionLines', 'New session lines', true),
          line(
            'grid.sessionLine',
            'New session lines style',
            { color: '', style: 'dash', width: 1 },
            undefined,
            { indent: true },
          ),
          bool(
            'grid.sessionShade',
            'Alternate session background',
            false,
            'Background colour per session.',
          ),
        ],
      },
      {
        id: 'axis',
        label: 'Axis',
        rows: [
          color('axis.bg', 'Axis background color'),
          color('axis.text', 'Axis text color'),
          num('axis.fontSize', 'Font size', 11, 8, 18),
          num('axis.width', 'Price axis width', 64, 40, 160),
          bool('axis.borders', 'Axis borders', true),
        ],
      },
      {
        id: 'candles',
        label: 'Candles',
        rows: [
          color('candles.up', 'Up candle color'),
          color('candles.down', 'Down candle color'),
          bool('candles.border', 'Draw candle border', false),
          bool('candles.sameAsBody', 'Same border / wick color as body', true),
          color('candles.borderColor', 'Candles border', '', undefined, { indent: true }),
          num('candles.borderWidth', 'Candle border width', 1, 1, 4, undefined, { indent: true }),
          slider('candles.bodyWidth', 'Body width (% of slot)', 60, 10, 100),
        ],
      },
      {
        id: 'bars',
        label: 'Bars',
        rows: [
          num('bars.width', 'Bar width', 1, 1, 4),
          color('bars.doji', 'Doji color'),
          color('bars.up', 'Up bar color'),
          color('bars.down', 'Down bar color'),
          bool('bars.showOpen', 'Show open', true),
          bool('bars.showClose', 'Show close', true),
        ],
      },
      {
        id: 'linearea',
        label: 'Line & Area chart',
        rows: [
          line('linearea.line', 'Line color', { color: '', style: 'solid', width: 2 }),
          line('linearea.areaLine', 'Area line', { color: '', style: 'solid', width: 1 }),
          grad(
            'linearea.areaFill',
            'Area background',
            '',
            'Two-colour vertical gradient under the area line. Empty = line colour fading out.',
          ),
        ],
      },
      {
        id: 'session',
        label: 'Session time',
        rows: [
          enm(
            'session.trading',
            'Trading session',
            '24h',
            TRADING_SESSIONS,
            'Right-click → Trading session. Time outside the session is shaded.',
          ),
          bool('session.custom', 'Custom session time', false),
          {
            key: 'session.begin',
            label: 'Session begin (UTC)',
            type: 'time',
            default: '00:00:00',
            indent: true,
          },
          {
            key: 'session.end',
            label: 'Session end (UTC)',
            type: 'time',
            default: '23:59:59',
            indent: true,
          },
        ],
      },
      {
        id: 'marks',
        label: 'Watermark & marks',
        rows: [
          bool('marks.watermark', 'Watermark', false, 'Large symbol + timeframe behind the bars.'),
          enm(
            'marks.watermarkContent',
            'Watermark content',
            'symbol-tf',
            opts(
              ['symbol-tf', 'Symbol + timeframe'],
              ['symbol', 'Symbol'],
              ['custom', 'Custom text'],
            ),
            undefined,
            { indent: true },
          ),
          {
            key: 'marks.watermarkText',
            label: 'Custom text',
            type: 'text',
            default: '',
            indent: true,
          },
          color('marks.watermarkColor', 'Watermark color', '', undefined, { indent: true }),
          slider('marks.watermarkOpacity', 'Watermark opacity %', 8, 2, 60, undefined, {
            indent: true,
          }),
          bool(
            'marks.highLow',
            'High / low marks',
            false,
            'Labels at the highest high and lowest low of the visible bars.',
          ),
          color('marks.highLowColor', 'High / low color', '', undefined, { indent: true }),
        ],
      },
      {
        id: 'other',
        label: 'Other',
        rows: [
          bool('other.indicatorValues', 'Indicator values on mouse over', true, undefined, {
            consumer: 'indicators',
          }),
          bool(
            'other.autoTransform',
            'Auto transform candles to footprint',
            true,
            'When you zoom in past the width below, candles turn into footprint clusters automatically.',
          ),
          num('other.autoTransformWidth', 'Candle width to auto transform', 20, 0, 200, undefined, {
            indent: true,
          }),
          bool(
            'other.hideFootprintPanel',
            'Hide footprint panel',
            false,
            'Hide the side tools panel.',
          ),
          bool(
            'other.hidePanels',
            'Hide panels',
            false,
            'Hide side tools and the bottom bar (right-click → Hide panels).',
          ),
          num(
            'other.priceOffset',
            'Price offset (px right of last bar)',
            0,
            0,
            2000,
            '0 = template default.',
          ),
          slider(
            'other.verticalOffset',
            'Chart vertical offset %',
            8,
            0,
            40,
            'Empty space above and below the bars when auto-scaling.',
          ),
          bool('other.smoothing', 'Smoothing', true, 'Smooth scaled images (heatmap).'),
          enm(
            'other.wheel',
            'Mouse wheel behavior',
            'zoom-time',
            opts(['zoom-time', 'Zoom time'], ['zoom-xy', 'Zoom XY'], ['scroll', 'Scroll']),
          ),
          bool('other.leaveRuler', 'Leave ruler on mouse release', false, undefined, {
            consumer: 'drawings',
          }),
          bool('other.scrollbar', 'Show chart horizontal scroll bar', false),
          bool('other.indicatorsList', 'Show indicators list', true, undefined, {
            consumer: 'indicators',
          }),
          bool('other.debug', 'Debug overlay (render time)', false),
        ],
      },
      {
        id: 'volume',
        label: 'Volume visualization',
        rows: [
          bool(
            'volume.pane',
            'Volume pane',
            true,
            'Volume bars under the price pane (Candles template).',
          ),
          num('volume.height', 'Volume pane height', 80, 24, 600, undefined, { indent: true }),
          bool('volume.minimize', 'Minimize volume values', true, '1.2K instead of 1,200.'),
          bool(
            'volume.quote',
            'Volumes in quote currency',
            false,
            'Volume × price (USDT for crypto).',
          ),
          num('volume.decimals', 'Digits after decimal point', 0, 0, 8),
        ],
      },
      {
        id: 'drawing',
        label: 'Drawing objects',
        rows: [
          bool('drawing.keepSelected', 'Keep selected objects', false, undefined, {
            consumer: 'drawings',
          }),
          color('drawing.selectionBg', 'Selection background color', '#FFBFBF', undefined, {
            consumer: 'drawings',
          }),
          color('drawing.highlight', 'Highlight color', '#4FA3F7', undefined, {
            consumer: 'drawings',
          }),
          num('drawing.magnetPx', 'Magnet sensitivity, pixels', 8, 1, 50, undefined, {
            consumer: 'drawings',
          }),
        ],
      },
      {
        id: 'update',
        label: 'Update frequency',
        rows: [
          bool(
            'update.highPerformance',
            'Enable high performance mode',
            false,
            'Caps redraws at 30 fps.',
          ),
          bool('update.custom', 'Customizable update frequency', false),
          slider('update.fps', 'Update frequency (fps)', 60, 5, 144, undefined, { indent: true }),
        ],
      },
    ],
  },
  {
    id: 'footprint',
    label: 'Footprint settings',
    sections: [
      {
        id: 'fpcontent',
        label: 'Footprint content',
        rows: [
          enm(
            'fp.mode',
            'Content / mode',
            'volume',
            FOOTPRINT_MODES.map((m) => ({ value: m.id, label: `${m.group} · ${m.label}` })),
            'Side tools and Alt+V / T / B / D change this too.',
            { bind: 'footprintMode' },
          ),
          enm(
            'fp.ticksPerRow',
            'Ticks per row',
            'auto',
            opts(
              ['auto', 'Auto'],
              ['1', '1'],
              ['2', '2'],
              ['4', '4'],
              ['5', '5'],
              ['10', '10'],
              ['20', '20'],
            ),
          ),
          bool('fp.borders', 'Draw borders', false),
        ],
      },
      {
        id: 'fpcolors',
        label: 'Color scheme',
        rows: [
          enm(
            'fp.scheme',
            'Color scheme',
            'bidask',
            opts(
              ['bidask', 'Bid/Ask volume proportion'],
              ['volume', 'Volume proportion'],
              ['delta', 'Delta'],
              ['heatmap', 'Heatmap'],
            ),
          ),
          color('fp.background', 'Background of footprint', ''),
          color('fp.mainColor', 'Main color', ''),
          color('fp.bidColor', 'Bid color', ''),
          color('fp.askColor', 'Ask color', ''),
          grad('fp.heatmap', 'Heatmap', '#0B0B0B,#4A1A6B,#B3263A'),
          slider('fp.cutoff', 'Upper cut-off, %', 62, 1, 100),
          slider('fp.contrast', 'Contrast', 14, 0, 100),
        ],
      },
      {
        id: 'fp2',
        label: 'Additional footprint',
        rows: [
          bool('fp2.enabled', 'Enabled', false),
          enm(
            'fp2.content',
            'Content',
            'volume',
            opts(['volume', 'Volume'], ['delta', 'Delta'], ['trades', 'Trades']),
          ),
          enm(
            'fp2.mode',
            'Mode',
            'full',
            opts(['full', 'Full row'], ['left', 'Left half'], ['right', 'Right half']),
          ),
          enm(
            'fp2.scheme',
            'Color scheme',
            'volume',
            opts(['volume', 'Volume proportion'], ['delta', 'Delta'], ['heatmap', 'Heatmap']),
          ),
          grad('fp2.heatmap', 'Heatmap', '#0B1A33,#1E5AA8,#8C8C8C,#E8B04B'),
          slider('fp2.cutoff', 'Upper cut-off, %', 25, 1, 100),
        ],
      },
      {
        id: 'fpborder',
        label: 'Outer border and direction indicator',
        rows: [
          enm(
            'fp.borderType',
            'Border type',
            'body',
            opts(['body', 'Body'], ['full', 'Full range'], ['none', 'None']),
          ),
          bool('fp.borderByDirection', 'Border color by direction', false),
          line('fp.border', 'Border', { color: '', style: 'solid', width: 2 }),
          slider('fp.directionWidth', 'Direction indicator width', 4, 0, 12),
        ],
      },
      {
        id: 'fptext',
        label: 'Text',
        rows: [
          bool('fp.showText', 'Show text', true),
          color('fp.textColor', 'Text color', ''),
          bool('fp.autoSize', 'Auto size', true),
          num('fp.fontSize', 'Font size', 11, 7, 20),
          enm(
            'fp.divider',
            'Values divider',
            'x',
            opts(['x', '×'], ['|', '|'], ['space', 'Space']),
          ),
          num('fp.textWidth', 'Width to show text', 40, 0, 400),
        ],
      },
      {
        id: 'fppoc',
        label: 'Maximum level / POC',
        rows: [
          bool('fp.poc', 'POC box per bar', true),
          enm(
            'fp.maxType',
            'Maximum volume type',
            'volume',
            opts(['volume', 'Volume'], ['delta', 'Delta'], ['trades', 'Trades']),
          ),
          color('fp.pocBorder', 'Border color', ''),
          slider('fp.pocBorderWidth', 'Border width', 1, 1, 10),
          color('fp.pocText', 'Text color', ''),
          bool('fp.pocBold', 'Bold text', true),
        ],
      },
      {
        id: 'fpva',
        label: 'Value area',
        rows: [
          color('fp.vaColor', 'Color', '#64C8D8'),
          num('fp.vaPct', 'Value area %', 70, 1, 100),
        ],
      },
      {
        id: 'fpprop',
        label: 'Proportion settings',
        rows: [
          enm(
            'fp.propMode',
            'Mode',
            'visible',
            opts(['visible', 'Visible region'], ['custom', 'Custom'], ['percentile', 'Percentile']),
          ),
          num('fp.propCustom', 'Custom proportion value', 0, 0, 1e9),
          slider('fp.percentile', 'Upper percentile', 95, 50, 100),
        ],
      },
      {
        id: 'fpimb',
        label: 'Bid/Ask imbalance settings',
        rows: [
          bool('fp.imbalance', 'Enabled', true),
          color('fp.imbBid', 'Bid color', ''),
          color('fp.imbAsk', 'Ask color', ''),
          num(
            'fp.imbRate',
            'Imbalance rate %',
            300,
            100,
            2000,
            'A price level is an imbalance when ask volume is this % of the bid volume one tick lower (diagonal).',
          ),
          num('fp.imbVolume', 'Volume filter', 0, 0, 1e9),
          num('fp.imbMinDiff', 'Minimum difference', 0, 0, 1e9),
          bool('fp.imbIgnoreZero', 'Ignore zero values', false),
          bool('fp.imbBold', 'Bold text', true),
          num('fp.imbStacked', 'Stacked imbalance (levels)', 3, 2, 10),
        ],
      },
      {
        id: 'fpfilters',
        label: 'Filters',
        rows: [
          num('fp.hideBelow', 'Hide values below', 0, 0, 1e9),
          {
            key: 'fp.filters',
            label: 'Filters',
            type: 'rules',
            default: [
              { field: 'volume', op: '>=', value: 50, color: '#E8B04B' },
              { field: 'delta', op: '<=', value: -40, color: '#F28A96' },
            ] as FilterRule[],
            help: 'Rule list: condition → highlight colour.',
          },
        ],
      },
    ],
  },
  {
    id: 'trading',
    label: 'Trading Settings',
    sections: [
      {
        id: 'trading',
        label: 'Trading',
        rows: [
          bool(
            'trading.oneClick',
            'One-click mode',
            false,
            'Place right-click chart orders without confirmation.',
            { consumer: 'trading' },
          ),
          enm(
            'trading.mode',
            'Trading from chart mode',
            'auto',
            opts(['auto', 'Auto detection'], ['limit', 'Limit only'], ['stop', 'Stop only']),
            'Auto: Buy Limit below / Sell Limit above the last price.',
          ),
          enm(
            'trading.stopMode',
            'Stop mode',
            'stop',
            opts(['stop', 'Stop'], ['stop-limit', 'Stop limit']),
            undefined,
            { consumer: 'trading' },
          ),
          num('trading.slippage', 'Slippage (ticks)', 5, 0, 1000, undefined, {
            consumer: 'trading',
          }),
        ],
      },
      {
        id: 'fills',
        label: 'Trades (fills on chart)',
        rows: [
          enm('fills.visibility', 'Visibility', 'visible', VISIBILITY, undefined, {
            consumer: 'trading',
          }),
          num('fills.size', 'Size', 6, 2, 30, undefined, { consumer: 'trading' }),
          color('fills.buy', 'Buy color', '#4FA3F7', undefined, { consumer: 'trading' }),
          color('fills.sell', 'Sell color', '#B07CF0', undefined, { consumer: 'trading' }),
        ],
      },
      {
        id: 'orders',
        label: 'Orders',
        rows: [
          enm('orders.visibility', 'Visibility', 'visible', VISIBILITY, undefined, {
            consumer: 'trading',
          }),
          num('orders.offset', 'Offset', 115, 0, 1000, undefined, { consumer: 'trading' }),
          color('orders.buy', 'Buy color', '#20C77A', undefined, { consumer: 'trading' }),
          color('orders.sell', 'Sell color', '#F04A5D', undefined, { consumer: 'trading' }),
          color('orders.text', 'Text color', '#D1D4DC', undefined, { consumer: 'trading' }),
          enm('orders.lineStyle', 'Line style', 'dash', LINE_STYLES, undefined, {
            consumer: 'trading',
          }),
        ],
      },
      {
        id: 'position',
        label: 'Position',
        rows: [
          enm('position.visibility', 'Visibility', 'visible', VISIBILITY, undefined, {
            consumer: 'trading',
          }),
          num('position.offset', 'Offset', 115, 0, 1000, undefined, { consumer: 'trading' }),
          color('position.buy', 'Buy color', '#20C77A', undefined, { consumer: 'trading' }),
          color('position.sell', 'Sell color', '#F04A5D', undefined, { consumer: 'trading' }),
          color('position.text', 'Text color', '#F1F1F1', undefined, { consumer: 'trading' }),
          color('position.bg', 'Background', '#0B0B0B', undefined, { consumer: 'trading' }),
          color('position.pnlPos', 'Positive PnL', '#20C77A', undefined, { consumer: 'trading' }),
          color('position.pnlNeg', 'Negative PnL', '#F04A5D', undefined, { consumer: 'trading' }),
        ],
      },
    ],
  },
];

export const ROWS: RowDef[] = TABS.flatMap((t) => t.sections.flatMap((s) => s.rows));
export const ROW_BY_KEY = new Map(ROWS.map((r) => [r.key, r]));

export const DEFAULTS: ChartSettings = Object.fromEntries(
  ROWS.filter((r) => !r.bind).map((r) => [r.key, structuredClone(r.default)]),
);

// ------------------------------------------------------------------ validation

const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;

export function validColor(v: unknown): v is string {
  return typeof v === 'string' && (v === '' || HEX.test(v));
}

/** Returns the validated value for a row, or undefined when invalid. */
export function validateValue(row: RowDef, v: unknown): unknown {
  switch (row.type) {
    case 'color':
      return validColor(v) ? v.toUpperCase() : undefined;
    case 'bool':
      return typeof v === 'boolean' ? v : undefined;
    case 'number':
    case 'slider': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
      return Math.min(row.max ?? Infinity, Math.max(row.min ?? -Infinity, v));
    }
    case 'enum':
      return typeof v === 'string' && row.options?.some((o) => o.value === v) ? v : undefined;
    case 'text':
      return typeof v === 'string' ? v.slice(0, 80) : undefined;
    case 'time':
      return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(v)
        ? v
        : undefined;
    case 'gradient':
      return typeof v === 'string' && (v === '' || v.split(',').every((c) => HEX.test(c)))
        ? v.toUpperCase()
        : undefined;
    case 'line': {
      if (!v || typeof v !== 'object') return undefined;
      const o = v as Partial<LineValue>;
      if (!validColor(o.color) || !['solid', 'dash', 'dot'].includes(o.style ?? ''))
        return undefined;
      if (typeof o.width !== 'number' || !Number.isFinite(o.width)) return undefined;
      return {
        color: o.color.toUpperCase(),
        style: o.style,
        width: Math.min(8, Math.max(0.5, o.width)),
      };
    }
    case 'rules': {
      if (!Array.isArray(v)) return undefined;
      const out: FilterRule[] = [];
      for (const r of v.slice(0, 32)) {
        const x = r as Partial<FilterRule>;
        if (
          !['volume', 'delta', 'trades', 'bid', 'ask'].includes(x.field ?? '') ||
          !['>=', '<='].includes(x.op ?? '') ||
          typeof x.value !== 'number' ||
          !Number.isFinite(x.value) ||
          !validColor(x.color) ||
          !x.color
        )
          return undefined;
        out.push({ field: x.field!, op: x.op!, value: x.value, color: x.color.toUpperCase() });
      }
      return out;
    }
  }
}

/** Full settings: defaults overlaid with every valid stored value (invalid / unknown keys dropped). */
export function normalizeSettings(raw: unknown): ChartSettings {
  const out: ChartSettings = structuredClone(DEFAULTS);
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const row = ROW_BY_KEY.get(k);
    if (!row || row.bind) continue;
    const ok = validateValue(row, v);
    if (ok !== undefined) out[k] = ok;
  }
  return out;
}

/** Only the keys that differ from the defaults (what is stored). */
export function diffFromDefaults(s: ChartSettings): ChartSettings {
  const out: ChartSettings = {};
  for (const [k, v] of Object.entries(s)) {
    if (!ROW_BY_KEY.has(k)) continue;
    if (JSON.stringify(v) !== JSON.stringify(DEFAULTS[k])) out[k] = v;
  }
  return out;
}

/** Resets every row of a tab to its default. */
export function resetTab(s: ChartSettings, tab: TabId): ChartSettings {
  const t = TABS.find((x) => x.id === tab);
  const next = { ...s };
  for (const sec of t?.sections ?? [])
    for (const r of sec.rows) if (!r.bind) next[r.key] = structuredClone(r.default);
  return next;
}

/** Rows matching a search query (label, key, section or help). */
export function matchesQuery(row: RowDef, section: SectionDef, q: string): boolean {
  if (!q) return true;
  const s = q.toLowerCase();
  return (
    row.label.toLowerCase().includes(s) ||
    row.key.toLowerCase().includes(s) ||
    section.label.toLowerCase().includes(s) ||
    (row.help ?? '').toLowerCase().includes(s)
  );
}

// ------------------------------------------------------------------ typed getters

export const sBool = (s: ChartSettings, k: string) => s[k] === true;
export const sNum = (s: ChartSettings, k: string) =>
  typeof s[k] === 'number' ? (s[k] as number) : 0;
export const sStr = (s: ChartSettings, k: string) =>
  typeof s[k] === 'string' ? (s[k] as string) : '';
export const sLine = (s: ChartSettings, k: string): LineValue =>
  (s[k] as LineValue | undefined) ?? { color: '', style: 'solid', width: 1 };
