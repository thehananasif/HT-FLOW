import {
  barSource,
  CandlesLayer,
  ChartCore,
  depthSource,
  DomBackdropLayer,
  LastPriceLayer,
  LegendLayer,
  PeriodProfilesLayer,
  PrintBuffer,
  SessionSeparatorLayer,
  StatsRowsLayer,
  TapeBubblesLayer,
  tradeSource,
  VolumePaneLayer,
  type ChartPalette,
} from '@htflow/chart-engine';
import { DomHistogramGutter, FootprintLayer, VisibleProfileGutter } from '@htflow/footprint';
import { LiquidityMapLayer } from '@htflow/heatmap';
import { specLabel, type BarSpec, type MarketStore } from '@htflow/market-data';
import type { ChartWindowState } from '@htflow/workspace';
import { chartExtensions, type ChartExtensionContext } from './extensions';

export interface ChartHandle {
  cores: ChartCore[];
  /** Extension contexts by extension id (for menus and overlays). */
  extCtx: Map<string, ChartExtensionContext>;
  /** Applies window-state changes that don't need a rebuild (mode, filters). */
  update(state: ChartWindowState): void;
  dispose(): void;
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
  let update: (s: ChartWindowState) => void = () => {};

  const mk = (host: HTMLElement, opts: ConstructorParameters<typeof ChartCore>[3] = {}) => {
    const c = new ChartCore(host, inst, palette, opts);
    cores.push(c);
    unsubs.push(store.subscribe(() => c.invalidate()));
    return c;
  };

  switch (state.template) {
    case 'candles-vp': {
      const c = mk(hosts[0]!);
      c.slotWidth = 9;
      c.setSource(barSource(series()));
      const profiles = new PeriodProfilesLayer(series);
      profiles.periodMs = spec.kind === 'time' && spec.ms >= 3_600_000 ? 86_400_000 : 3_600_000;
      c.setLayers([
        profiles,
        new SessionSeparatorLayer(series),
        new CandlesLayer(series),
        new VolumePaneLayer(series),
        new LastPriceLayer(lastPx(store)),
        new LegendLayer(
          series,
          venueTitle(
            store,
            `${specLabel(spec)} · session profiles: ${profiles.periodMs >= 86_400_000 ? '1 day' : '1 h'}`,
          ),
        ),
      ]);
      break;
    }
    case 'footprint': {
      const c = mk(hosts[0]!);
      c.slotWidth = 118;
      c.options.rightMargin = 1;
      c.rightOffset = 0.6;
      c.setSource(barSource(series()));
      const fp = new FootprintLayer(series, { mode: state.footprintMode });
      const candles = new CandlesLayer(series);
      const syncCandle = () => {
        const v = c.view;
        candles.strip = !(v && fp.collapsed(v));
      };
      candles.strip = true;
      const legend = new LegendLayer(
        series,
        venueTitle(store, `${specLabel(spec)} · ${fp.mode.label}`),
      );
      c.setLayers([
        new VisibleProfileGutter(series, () => fp.rowTicks),
        new SessionSeparatorLayer(series),
        { id: 'sync', draw: syncCandle },
        candles,
        fp,
        new DomHistogramGutter(
          () => store.book,
          () => fp.rowTicks,
        ),
        new StatsRowsLayer(series),
        new LastPriceLayer(lastPx(store)),
        legend,
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
      const legend = new LegendLayer(
        () => null,
        () =>
          `Heatmap · depth history ${Math.round((store.depth.length * 250) / 60000)} min · bubbles = trades ≥ ${lm.settings.minLots} lots · Best bid/ask`,
      );
      c.setLayers([lm, legend]);
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
      const stats = new StatsRowsLayer(series);
      stats.style = 'heat';
      left.setLayers([
        new CandlesLayer(series),
        stats,
        new LegendLayer(series, venueTitle(store, '')),
      ]);
      const prints = new PrintBuffer(state.minLots);
      const getPrints = () => prints.update(store.trades);
      right.slotWidth = 16;
      right.options.rightMargin = 2;
      right.rightOffset = 2;
      right.setSource(tradeSource(getPrints));
      right.setLayers([
        new DomBackdropLayer(() => store.book),
        new TapeBubblesLayer(getPrints, () => inst.qtyPrecision),
        new LastPriceLayer(lastPx(store), () => ({
          bid: store.book.bestBid,
          ask: store.book.bestAsk,
        })),
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
