/** Applies per-chart settings (P34) to a built chart — live, without rebuilding. */
import {
  countdownLabel,
  DEFAULT_STYLE,
  zoneOffsetMin,
  type CandleMode,
  type ChartPalette,
  type ChartStyle,
  type LineStyle,
  type MouseMode,
  type PriceAxisSide,
  type PriceScaleMode,
  type StrokeStyle,
  type WheelBehavior,
} from '@htflow/chart-engine';
import { formatCompact, type Instrument, type MarketStore } from '@htflow/market-data';
import { getSetting } from '../../state/settings';
import type { ChartHandle } from '../buildChart';
import { sBool, sLine, sNum, sStr, type ChartSettings, type LineValue } from './schema';

const stroke = (l: LineValue): StrokeStyle => ({
  color: l.color,
  style: l.style as LineStyle,
  width: l.width,
});

/** "HH:MM[:SS]" → ms after midnight. */
export function timeToMs(s: string): number {
  const [h = 0, m = 0, sec = 0] = s.split(':').map(Number);
  return ((h * 60 + m) * 60 + sec) * 1000;
}

/** The chart's time zone: per-chart choice, else Settings → Time zones → Chart axis. */
export function resolveTimeZone(choice: string, inst: Instrument): string {
  let z = choice;
  if (z === 'default') {
    z = String(getSetting('timezones.chartAxis') ?? 'app');
    if (z === 'app') z = String(getSetting('timezones.app') ?? 'UTC');
  }
  if (z === 'exchange') z = inst.assetClass === 'crypto' ? 'UTC' : 'America/Chicago';
  return z || 'UTC';
}

/** Session window [begin, end) in ms after 00:00 UTC for the trading-session choice, or null. */
export function sessionWindow(s: ChartSettings, now = Date.now()): [number, number] | null {
  const mode = sStr(s, 'session.trading');
  if (mode === 'rth') {
    const off = zoneOffsetMin('America/New_York', now) * 60_000;
    const day = 86_400_000;
    return [
      (((9.5 * 3_600_000 - off) % day) + day) % day,
      (((16 * 3_600_000 - off) % day) + day) % day,
    ];
  }
  if (mode === 'custom' || sBool(s, 'session.custom'))
    return [timeToMs(sStr(s, 'session.begin')), timeToMs(sStr(s, 'session.end'))];
  return null;
}

/** Volume formatter from Volume visualization settings. */
export function volumeFormatter(
  s: ChartSettings,
  inst: Instrument,
  price: () => number,
): (v: number) => string {
  const dec = sNum(s, 'volume.decimals');
  const quote = sBool(s, 'volume.quote');
  const min = sBool(s, 'volume.minimize');
  return (v) => {
    const x = quote ? v * price() * inst.tickSize : v;
    if (min) return formatCompact(Math.round(x * 10 ** dec) / 10 ** dec);
    return x.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  };
}

function lastStop(grad: string): string {
  const parts = grad.split(',').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** Palette of one chart: theme palette with the chart's colour overrides. */
export function chartPalette(base: ChartPalette, s: ChartSettings): ChartPalette {
  const p = { ...base };
  const bg = sStr(s, 'main.background');
  if (bg) p.chartBg = bg;
  const sep = sLine(s, 'main.separators').color;
  if (sep) p.border = sep;
  const lbl = sStr(s, 'main.indicatorLabelColor');
  if (lbl) p.textSoft = lbl;
  return p;
}

export interface ApplyContext {
  store: MarketStore;
  palette: ChartPalette;
  symbol: string;
  isReplay: boolean;
  /** Settings applied last time (to apply one-shot changes like auto-scale only when edited). */
  prev: ChartSettings | null;
  panes: Record<string, number> | undefined;
}

export function applyChartSettings(h: ChartHandle, s: ChartSettings, c: ApplyContext): void {
  const inst = c.store.instrument;
  const pal = chartPalette(c.palette, s);
  const L = h.layers;
  const changed = (k: string) => !c.prev || JSON.stringify(c.prev[k]) !== JSON.stringify(s[k]);

  const style: ChartStyle = {
    background2: sStr(s, 'main.background2'),
    grid: {
      h: sBool(s, 'grid.horizontal'),
      v: sBool(s, 'grid.vertical'),
      line: stroke(sLine(s, 'grid.line')),
      barStep: sStr(s, 'grid.stepUnit') === 'bars' ? sNum(s, 'grid.barStep') : 0,
    },
    crosshair: {
      line: stroke(sLine(s, 'crosshair.line')),
      labelBg: sStr(s, 'crosshair.labelBg'),
      labelText: sStr(s, 'crosshair.labelText'),
      snap: sBool(s, 'crosshair.snap'),
    },
    axis: {
      bg: sStr(s, 'axis.bg'),
      text: sStr(s, 'axis.text'),
      fontSize: sNum(s, 'axis.fontSize') || DEFAULT_STYLE.axis.fontSize,
      border: sBool(s, 'axis.borders'),
    },
    timeFormat: sStr(s, 'scales.timeFormat') === '12h' ? '12h' : '24h',
  };
  const fps = sBool(s, 'update.custom')
    ? sNum(s, 'update.fps')
    : sBool(s, 'update.highPerformance')
      ? 30
      : 0;
  const tz = resolveTimeZone(sStr(s, 'scales.timeZone'), inst);
  for (const core of h.cores) {
    core.setPalette(pal);
    core.setStyle(style);
    core.setOptions({
      scaleMode: sStr(s, 'scales.mode') as PriceScaleMode,
      invertScale: sBool(s, 'scales.invert'),
      priceAxisSide: sStr(s, 'scales.side') as PriceAxisSide,
      gaps: sBool(s, 'scales.gaps') && h.periodMs !== null && core === h.main,
      timeZone: tz,
      wheel: sStr(s, 'other.wheel') as WheelBehavior,
      maxFps: fps,
      autoScalePadding: sNum(s, 'other.verticalOffset') / 100,
      priceAxisWidth: sNum(s, 'axis.width'),
    });
    if (changed('scales.autoScale') && !core.linkedPrice)
      core.autoScale = sBool(s, 'scales.autoScale');
    const off = sNum(s, 'other.priceOffset');
    if (off > 0 && changed('other.priceOffset')) {
      core.options.rightMargin = Math.max(0, off / core.slotWidth);
      core.rightOffset = core.options.rightMargin;
    }
    core.showDebug = sBool(s, 'other.debug');
    core.mouseMode = sStr(s, 'crosshair.mouseMode') as MouseMode;
    core.ctx.imageSmoothingEnabled = sBool(s, 'other.smoothing');
    core.paneHeights.clear();
    for (const [k, v] of Object.entries(c.panes ?? {})) core.paneHeights.set(k, v);
  }

  if (L.candles) {
    L.candles.mode = sStr(s, 'main.displayMode') as CandleMode;
    const bars = L.candles.mode === 'bars';
    L.candles.bodyPct = sNum(s, 'candles.bodyWidth') / 100;
    L.candles.style = {
      up: (bars && sStr(s, 'bars.up')) || sStr(s, 'candles.up'),
      down: (bars && sStr(s, 'bars.down')) || sStr(s, 'candles.down'),
      border: sBool(s, 'candles.border'),
      sameBorderAsBody: sBool(s, 'candles.sameAsBody'),
      borderColor: sStr(s, 'candles.borderColor'),
      borderWidth: sNum(s, 'candles.borderWidth'),
      direction: sStr(s, 'main.candleDirection') === 'close-prev' ? 'close-prev' : 'close-open',
      barWidth: sNum(s, 'bars.width'),
      dojiColor: sStr(s, 'bars.doji'),
      showOpen: sBool(s, 'bars.showOpen'),
      showClose: sBool(s, 'bars.showClose'),
      line: stroke(sLine(s, 'linearea.line')),
      areaLine: stroke(sLine(s, 'linearea.areaLine')),
      areaTop: sStr(s, 'linearea.areaFill').split(',')[0] ?? '',
      areaBottom: sStr(s, 'linearea.areaFill').split(',')[1] ?? '',
    };
  }
  const lastPrice = () => c.store.lastTrade?.px ?? 0;
  const fmtVol = volumeFormatter(s, inst, lastPrice);
  if (L.legend) {
    L.legend.opts = {
      show: sBool(s, 'main.legend'),
      title: sBool(s, 'main.legendTitle'),
      ohlc: sBool(s, 'main.ohlcValues'),
      byCandle: sBool(s, 'main.ohlcByCandle'),
      color: sStr(s, 'main.ohlcColor'),
      change: sBool(s, 'main.barChange'),
      volume: sBool(s, 'main.legendVolume'),
      delta: sBool(s, 'main.legendDelta'),
      formatVol: fmtVol,
    };
  }
  if (L.volume) {
    L.volume.visible = sBool(s, 'volume.pane');
    L.volume.height = c.panes?.['volume-pane'] ?? sNum(s, 'volume.height');
    L.volume.format = fmtVol;
  }
  if (L.lastPrice) {
    const lp = L.lastPrice;
    lp.showLine = sBool(s, 'price.show');
    lp.line = stroke(sLine(s, 'price.line'));
    lp.extend = sBool(s, 'price.extend');
    if (h.cores.length === 1) lp.showBidAsk = sBool(s, 'price.bidAsk');
    const period = h.periodMs;
    lp.countdown =
      sBool(s, 'price.countdown') && period
        ? () => {
            const bars = h.series()?.bars;
            const now = c.isReplay ? c.store.lastTs : Date.now();
            return countdownLabel(bars?.[bars.length - 1]?.t, period, now);
          }
        : null;
  }
  const win = sessionWindow(s);
  if (L.sessions) {
    L.sessions.visible = sBool(s, 'grid.sessionLines');
    L.sessions.line = stroke(sLine(s, 'grid.sessionLine'));
    L.sessions.offsetMs = win ? win[0] : 0;
  }
  if (L.shade) {
    L.shade.visible = !!win || sBool(s, 'grid.sessionShade');
    L.shade.beginMs = win ? win[0] : 0;
    L.shade.endMs = win ? win[1] : 0;
    L.shade.alternate = sBool(s, 'grid.sessionShade');
  }
  if (L.watermark) {
    const wm = L.watermark;
    wm.visible = sBool(s, 'marks.watermark');
    wm.color = sStr(s, 'marks.watermarkColor');
    wm.opacity = sNum(s, 'marks.watermarkOpacity') / 100;
    const content = sStr(s, 'marks.watermarkContent');
    const custom = sStr(s, 'marks.watermarkText');
    const tf = c.symbol;
    if (content === 'custom') wm.text = () => custom;
    else if (content === 'symbol') wm.text = () => inst.symbol;
    else wm.text = () => tf;
  }
  if (L.highLow) {
    L.highLow.visible = sBool(s, 'marks.highLow');
    L.highLow.color = sStr(s, 'marks.highLowColor');
  }
  if (L.profiles) L.profiles.valueAreaPct = sNum(s, 'fp.vaPct') / 100;
  if (L.footprint) {
    const fs = L.footprint.settings;
    fs.autoCandleWidth = sBool(s, 'other.autoTransform') ? sNum(s, 'other.autoTransformWidth') : 0;
    const tpr = sStr(s, 'fp.ticksPerRow');
    fs.ticksPerRow = tpr === 'auto' ? 'auto' : Number(tpr);
    fs.showPoc = sBool(s, 'fp.poc');
    fs.imbalance = {
      enabled: sBool(s, 'fp.imbalance'),
      ratio: sNum(s, 'fp.imbRate') / 100,
      minVolume: sNum(s, 'fp.imbVolume'),
      stacked: sNum(s, 'fp.imbStacked'),
    };
    fs.hideBelow = sNum(s, 'fp.hideBelow');
  }
  if (L.footprintPalette) {
    const o: Partial<ChartPalette> = {};
    const set = (k: keyof ChartPalette, v: string) => {
      if (v) o[k] = v;
    };
    set('down', sStr(s, 'fp.bidColor') || sStr(s, 'fp.imbBid'));
    set('up', sStr(s, 'fp.askColor') || sStr(s, 'fp.imbAsk'));
    set('cluster', sStr(s, 'fp.mainColor'));
    set('clusterStrong', lastStop(sStr(s, 'fp.heatmap')));
    set('textPrimary', sStr(s, 'fp.textColor'));
    set('textSoft', sStr(s, 'fp.pocBorder'));
    L.footprintPalette.over = o;
  }
  for (const core of h.cores) core.invalidate();
}
