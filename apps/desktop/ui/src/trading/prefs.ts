import { PAPER_ACCOUNT } from '../state/market';
import { Persisted, usePersisted } from './persist';

/** What an order confirmation can be asked for (Settings → per-order-type toggles). */
export type ConfirmKind =
  | 'market'
  | 'limit'
  | 'stop'
  | 'stop-limit'
  | 'mit'
  | 'trailing-stop'
  | 'iceberg'
  | 'modify'
  | 'cancel'
  | 'close';

export const CONFIRM_KINDS: { id: ConfirmKind; label: string }[] = [
  { id: 'market', label: 'Market orders' },
  { id: 'limit', label: 'Limit orders' },
  { id: 'stop', label: 'Stop orders' },
  { id: 'stop-limit', label: 'Stop-limit orders' },
  { id: 'mit', label: 'Market-if-touched orders' },
  { id: 'trailing-stop', label: 'Trailing stops' },
  { id: 'iceberg', label: 'Iceberg orders' },
  { id: 'modify', label: 'Modify (drag on chart)' },
  { id: 'cancel', label: 'Cancel orders' },
  { id: 'close', label: 'Close / flatten / reverse' },
];

export type LineStyle = 'solid' | 'dashed' | 'dotted';

/** Chart trading visuals (every one customizable; '' colour = theme default). */
export interface ChartTradingPrefs {
  /** "Trading on chart": order / position lines and drag-to-modify. */
  enabled: boolean;
  showPosition: boolean;
  showOrders: boolean;
  showBrackets: boolean;
  showFills: boolean;
  /** Show unrealized P&L on the position line. */
  showPnl: boolean;
  buyColor: string;
  sellColor: string;
  slColor: string;
  tpColor: string;
  positionColor: string;
  lineWidth: number;
  lineStyle: LineStyle;
  labelSide: 'left' | 'right';
  /** Fill marker size in px. */
  markerSize: number;
  /** Maximum number of fill markers drawn per chart. */
  maxMarkers: number;
}

export type TpUnit = 'ticks' | 'usd' | 'percent' | 'points';
export type SlKind = 'ticks' | 'trailing' | 'atr';

export interface TradingPrefs {
  activeAccount: string;
  /** Selected ATM template id, or '' for the panel's custom SL / TP. */
  atmId: string;
  /** SL / TP (bracket) on new entries. */
  bracketOn: boolean;
  /** Custom SL / TP fields of the Trading Panel. */
  tp: number;
  tpUnit: TpUnit;
  sl: number;
  slKind: SlKind;
  confirm: Record<ConfirmKind, boolean>;
  chart: ChartTradingPrefs;
}

export const DEFAULT_CHART_PREFS: ChartTradingPrefs = {
  enabled: true,
  showPosition: true,
  showOrders: true,
  showBrackets: true,
  showFills: true,
  showPnl: true,
  buyColor: '',
  sellColor: '',
  slColor: '',
  tpColor: '',
  positionColor: '',
  lineWidth: 1,
  lineStyle: 'dashed',
  labelSide: 'left',
  markerSize: 7,
  maxMarkers: 500,
};

export function defaultPrefs(): TradingPrefs {
  return {
    activeAccount: PAPER_ACCOUNT,
    atmId: '',
    bracketOn: false,
    tp: 10,
    tpUnit: 'ticks',
    sl: 10,
    slKind: 'ticks',
    confirm: Object.fromEntries(CONFIRM_KINDS.map((k) => [k.id, false])) as Record<
      ConfirmKind,
      boolean
    >,
    chart: { ...DEFAULT_CHART_PREFS },
  };
}

const clamp = (v: unknown, lo: number, hi: number, d: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
const color = (v: unknown) => (typeof v === 'string' && /^(#[0-9a-f]{3,8})?$/i.test(v) ? v : '');
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

/** Validates persisted prefs field by field (unknown / invalid values fall back to defaults). */
export function normalizePrefs(raw: unknown): TradingPrefs {
  const d = defaultPrefs();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Partial<TradingPrefs>;
  const c = (r.chart ?? {}) as Partial<ChartTradingPrefs>;
  const dc = d.chart;
  return {
    activeAccount: typeof r.activeAccount === 'string' ? r.activeAccount : d.activeAccount,
    atmId: typeof r.atmId === 'string' ? r.atmId : '',
    bracketOn: bool(r.bracketOn, d.bracketOn),
    tp: clamp(r.tp, 0.0001, 1e9, d.tp),
    tpUnit: (['ticks', 'usd', 'percent', 'points'] as const).includes(r.tpUnit as TpUnit)
      ? r.tpUnit!
      : d.tpUnit,
    sl: clamp(r.sl, 0.0001, 1e9, d.sl),
    slKind: (['ticks', 'trailing', 'atr'] as const).includes(r.slKind as SlKind)
      ? r.slKind!
      : d.slKind,
    confirm: Object.fromEntries(
      CONFIRM_KINDS.map((k) => [k.id, bool(r.confirm?.[k.id], false)]),
    ) as Record<ConfirmKind, boolean>,
    chart: {
      enabled: bool(c.enabled, dc.enabled),
      showPosition: bool(c.showPosition, dc.showPosition),
      showOrders: bool(c.showOrders, dc.showOrders),
      showBrackets: bool(c.showBrackets, dc.showBrackets),
      showFills: bool(c.showFills, dc.showFills),
      showPnl: bool(c.showPnl, dc.showPnl),
      buyColor: color(c.buyColor),
      sellColor: color(c.sellColor),
      slColor: color(c.slColor),
      tpColor: color(c.tpColor),
      positionColor: color(c.positionColor),
      lineWidth: clamp(c.lineWidth, 1, 4, dc.lineWidth),
      lineStyle: (['solid', 'dashed', 'dotted'] as const).includes(c.lineStyle as LineStyle)
        ? c.lineStyle!
        : dc.lineStyle,
      labelSide: c.labelSide === 'right' ? 'right' : 'left',
      markerSize: clamp(c.markerSize, 3, 16, dc.markerSize),
      maxMarkers: Math.round(clamp(c.maxMarkers, 0, 5000, dc.maxMarkers)),
    },
  };
}

export const tradingPrefs = new Persisted<TradingPrefs>('trading.prefs', defaultPrefs, normalizePrefs);

export const useTradingPrefs = () => usePersisted(tradingPrefs);

export function setPrefs(patch: Partial<TradingPrefs>): void {
  tradingPrefs.update((p) => ({ ...p, ...patch }));
}

export function setChartPrefs(patch: Partial<ChartTradingPrefs>): void {
  tradingPrefs.update((p) => ({ ...p, chart: { ...p.chart, ...patch } }));
}
