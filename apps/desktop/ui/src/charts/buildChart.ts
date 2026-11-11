import {
  barSource,
  CandlesLayer,
  ChartCore,
  CompareLayer,
  depthSource,
  DomBackdropLayer,
  HighLowMarksLayer,
  LastPriceLayer,
  LegendLayer,
  PeriodProfilesLayer,
  PrintBuffer,
  SessionSeparatorLayer,
  SessionShadeLayer,
  StatsRowsLayer,
  TapeBubblesLayer,
  tradeSource,
  VolumePaneLayer,
  WatermarkLayer,
  type ChartLayer,
  type ChartPalette,
  type ChartView,
} from '@htflow/chart-engine';
import { DomHistogramGutter, FootprintLayer, VisibleProfileGutter } from '@htflow/footprint';
import { LiquidityMapLayer } from '@htflow/heatmap';
import { specLabel, type BarSeries, type BarSpec, type MarketStore } from '@htflow/market-data';
import type { ChartWindowState } from '@htflow/workspace';
import { chartExtensions, type ChartExtensionContext } from './extensions';

/** Named layers that Chart settings (P34) configure in place. */
export interface ChartLayers {
  candles?: CandlesLayer;
  legend?: LegendLayer;
  lastPrice?: LastPriceLayer;
  volume?: VolumePaneLayer;
  sessions?: SessionSeparatorLayer;
  shade?: SessionShadeLayer;
  watermark?: WatermarkLayer;
  highLow?: HighLowMarksLayer;
  compare?: CompareLayer;
  footprint?: FootprintLayer;
  /** Palette overrides used only by the footprint layer (bid / ask / main / text colours). */
  footprintPalette?: PaletteOverride;
}

export interface ChartHandle {
  cores: ChartCore[];
  /** Core that shows bars (left core for Order Flow); the only core for other templates. */
  main: ChartCore;
  layers: ChartLayers;
  /** Main bar series (null for the liquidity map). */
  series(): BarSeries | null;
  /** Bar period for countdowns (time bars only). */
  periodMs: number | null;
  /** Extension contexts by extension id (for menus and overlays). */
  extCtx: Map<string, ChartExtensionContext>;
  /** Applies window-state changes that don't need a rebuild (mode, filters). */
  update(state: ChartWindowState): void;
  dispose(): void;
}

/** Wraps a layer so it draws with some palette entries replaced (per-layer colours). */
export class PaletteOverride implements ChartLayer {
  readonly id: string;
  over: Partial<ChartPalette> = {};
  constructor(readonly inner: ChartLayer) {
    this.id = inner.id;
  }
  priceRange(i0: number, i1: number) {
    return this.inner.priceRange?.(i0, i1) ?? null;
  }
  leftGutter() {
    return this.inner.leftGutter?.() ?? 0;
  }
  rightGutter() {
    return this.inner.rightGutter?.() ?? 0;
  }
  bottomHeight() {
    return this.inner.bottomHeight?.() ?? 0;
  }
  draw(v: ChartView): void {
    const keys = Object.keys(this.over);
    this.inner.draw(keys.length ? { ...v, palette: { ...v.palette, ...this.over } } : v);
  }
  onClick(v: ChartView, x: number, y: number, e: MouseEvent): boolean {
    return this.inner.onClick?.(v, x, y, e) ?? false;
  }
}

const lastPx = (store: MarketStore) => () => {
  const t = store.lastTrade;
  if (!t) return null;
  const prev = store.trades[store.trades.length - 2];
  return { px: t.px, up: !prev || t.px >= prev.px ? t.side !== 'sell' : false };
};

function venueTitle(store: MarketStore, extra: string) {
  const i = store.instrument;
  return () => `${i.displayName} @ ${i.exchange}${extra ? ' · ' + extra : ''}`;
}

/**
 * Builds one of the four core charts on ChartCore (fast-track rule 3: one renderer, four layers).
 * Every renderer reads the same Bar.clusters, so switching template or footprint mode never reloads data.
 */
export function buildChart(
  hosts: HTMLElement[],
  store: MarketStore,
  state: ChartWindowState,
  palette: ChartPalette,
  opts: { windowId: string; setExt(id: string, value: unknown): void } = {
    windowId: '',
    setExt: () => {},
  },
): ChartHandle {
  let current = state;
  const inst = store.instrument;
  const spec = state.timeframe as BarSpec;
  const series = () => store.getSeries(spec);
  const cores: ChartCore[] = [];
  const unsubs: (() => void)[] = [];
  const L: ChartLayers = {};
  let update: (s: ChartWindowState) => void = () => {};

  const mk = (host: HTMLElement, opts: ConstructorParameters<typeof ChartCore>[3] = {}) => {
    const c = new ChartCore(host, inst, palette, opts);
    cores.push(c);
    unsubs.push(store.subscribe(() => c.invalidate()));
    return c;
  };
  const closeAt = (i: number) => series().bars[i]?.c ?? null;
  const watermarkText = () => `${inst.symbol} · ${specLabel(spec)}`;
  /** Chart-core layers shared by every bar template: watermark + session shading at the back. */
  const backLayers = () => {
    L.watermark = new WatermarkLayer(watermarkText);
    L.shade = new SessionShadeLayer(series);
    return [L.watermark, L.shade];
  };
  const frontLayers = () => {
    L.highLow = new HighLowMarksLayer(series);
    L.compare = new CompareLayer(series);
    return [L.compare, L.highLow];
  };

  switch (state.template) {
    case 'candles-vp': {
      const c = mk(hosts[0]!);
      c.slotWidth = 9;
      c.setSource(barSource(series()));
      c.valueAt = closeAt;
      const profiles = new PeriodProfilesLayer(series);
      profiles.periodMs = spec.kind === 'time' && spec.ms >= 3_600_000 ? 86_400_000 : 3_600_000;
      L.sessions = new SessionSeparatorLayer(series);
      L.candles = new CandlesLayer(series);
      L.volume = new VolumePaneLayer(series);
      L.lastPrice = new LastPriceLayer(lastPx(store), () => ({
        bid: store.book.bestBid,
        ask: store.book.bestAsk,
      }));
      L.legend = new LegendLayer(
        series,
        venueTitle(
          store,
          `${specLabel(spec)} · session profiles: ${profiles.periodMs >= 86_400_000 ? '1 day' : '1 h'}`,
        ),
      );
      c.setLayers([
        ...backLayers(),
        profiles,
        L.sessions,
        L.candles,
        L.volume,
        ...frontLayers(),
        L.lastPrice,
        L.legend,
      ]);
      break;
    }
    case 'footprint': {
      const c = mk(hosts[0]!);
      c.slotWidth = 118;
      c.options.rightMargin = 1;
      c.rightOffset = 0.6;
      c.setSource(barSource(series()));
      c.valueAt = closeAt;
      const fp = new FootprintLayer(series, { mode: state.footprintMode });
      L.footprint = fp;
      L.footprintPalette = new PaletteOverride(fp);
      const candles = new CandlesLayer(series);
      L.candles = candles;
      const syncCandle = () => {
        const v = c.view;
        candles.strip = !(v && fp.collapsed(v));
      };
      candles.strip = true;
      L.legend = new LegendLayer(
        series,
        venueTitle(store, `${specLabel(spec)} · ${fp.mode.label}`),
      );
      L.sessions = new SessionSeparatorLayer(series);
      L.lastPrice = new LastPriceLayer(lastPx(store), () => ({
        bid: store.book.bestBid,
        ask: store.book.bestAsk,
      }));
      c.setLayers([
        new VisibleProfileGutter(series, () => fp.rowTicks),
        ...backLayers(),
        L.sessions,
        { id: 'sync', draw: syncCandle },
        candles,
        L.footprintPalette,
        new DomHistogramGutter(
          () => store.book,
          () => fp.rowTicks,
        ),
        new StatsRowsLayer(series),
        ...frontLayers(),
        L.lastPrice,
        L.legend,
      ]);
      update = (s) => {
        fp.settings.mode = s.footprintMode;
        c.invalidate();
      };
      break;
    }
    case 'liquidity-map': {
      const c = mk(hosts[0]!, { priceAxis: false });
      c.slotWidth = 2.5;
      c.options.rightMargin = 30;
      c.rightOffset = 30;
      c.options.minSlotWidth = 0.5;
      const stride = Math.max(1, Math.round(state.heatColumnMs / 250));
      c.setSource(depthSource(() => store.depth, stride));
      const lm = new LiquidityMapLayer(
        () => store.depth,
        (from, to) => store.tradesBetween(from, to),
        () => store.book,
        { minLots: state.minLots },
      );
      lm.stride = stride;
      L.watermark = new WatermarkLayer(() => `${inst.symbol} · Heatmap`);
      L.legend = new LegendLayer(
        () => null,
        () =>
          `Heatmap · depth history ${Math.round((store.depth.length * 250) / 60000)} min · bubbles = trades ≥ ${lm.settings.minLots} lots · Best bid/ask`,
      );
      c.setLayers([L.watermark, lm, L.legend]);
      update = (s) => {
        lm.settings.minLots = s.minLots;
        c.invalidate();
      };
      break;
    }
    case 'order-flow-dark': {
      const left = mk(hosts[0]!, { priceAxis: false });
      const right = mk(hosts[1]!, { priceAxis: true });
      left.slotWidth = 21;
      left.setSource(barSource(series()));
      left.valueAt = closeAt;
      const stats = new StatsRowsLayer(series);
      stats.style = 'heat';
      L.candles = new CandlesLayer(series);
      L.legend = new LegendLayer(series, venueTitle(store, ''));
      left.setLayers([...backLayers(), L.candles, stats, ...frontLayers(), L.legend]);
      const prints = new PrintBuffer(state.minLots);
      const getPrints = () => prints.update(store.trades);
      right.slotWidth = 16;
      right.options.rightMargin = 2;
      right.rightOffset = 2;
      right.setSource(tradeSource(getPrints));
      L.lastPrice = new LastPriceLayer(lastPx(store), () => ({
        bid: store.book.bestBid,
        ask: store.book.bestAsk,
      }));
      L.lastPrice.showBidAsk = true;
      right.setLayers([
        new DomBackdropLayer(() => store.book),
        new TapeBubblesLayer(getPrints, () => inst.qtyPrecision),
        L.lastPrice,
        new LegendLayer(
          () => null,
          () => `C · FIFO · Tape chart ON · prints ≥ ${prints.minQty} lots`,
        ),
      ]);
      // Left candles share the tape's price scale.
      left.linkedPrice = right;
      unsubs.push(right.onPriceRange(() => left.invalidate()));
      update = (s) => {
        prints.minQty = s.minLots;
        prints.reset();
        right.invalidate();
      };
      break;
    }
  }

  // Chart extensions (indicators, drawings, …) attach to the core that shows bars.
  const main = cores[0]!;
  const hasBars = state.template !== 'liquidity-map';
  const extCtx = new Map<string, ChartExtensionContext>();
  for (const ext of chartExtensions()) {
    const ctx: ChartExtensionContext = {
      windowId: opts.windowId,
      store,
      state: () => current,
      series: () => (hasBars ? series() : null),
      core: main,
      cores,
      setExt: (value) => opts.setExt(ext.id, value),
    };
    extCtx.set(ext.id, ctx);
    const extra = ext.layers?.(ctx) ?? [];
    if (extra.length) {
      // Insert before legend so the legend stays on top.
      const li = main.layers.findIndex((l) => l.id === 'legend');
      const layers = main.layers.slice();
      layers.splice(li < 0 ? layers.length : li, 0, ...extra);
      main.setLayers(layers);
    }
    const dispose = ext.attach?.(ctx);
    if (dispose) unsubs.push(dispose);
  }

  return {
    cores,
    main,
    layers: L,
    series: () => (hasBars ? series() : null),
    periodMs: spec.kind === 'time' ? spec.ms : null,
    extCtx,
    update(s) {
      current = s;
      update(s);
      cores.forEach((c) => c.invalidate());
    },
    dispose() {
      unsubs.forEach((u) => u());
      cores.forEach((c) => c.destroy());
    },
  };
}
