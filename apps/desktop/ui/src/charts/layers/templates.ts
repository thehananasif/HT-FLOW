import {
  barSource,
  CandlesLayer,
  ChartCore,
  LastPriceLayer,
  LegendLayer,
  SessionSeparatorLayer,
  StatsRowsLayer,
  VolumePaneLayer,
  type ChartPalette,
} from '@htflow/chart-engine';
import { FootprintLayer } from '@htflow/footprint';
import { specLabel, type BarSeries, type BarSpec, type MarketStore } from '@htflow/market-data';
import { THEMES } from '@htflow/ui-kit';
import type { ChartTemplateId, ChartWindowState } from '@htflow/workspace';
import { toPalette } from '../palette';
import { CotPaneLayer, CotTableLayer, cotSource } from './cotLayers';
import { cotData, resolveCot, type CotData } from './cotModel';
import type { CotReport } from './cotMarkets';
import { getSetting } from '../../state/settings';
import { useCot } from '../../state/cot';
import {
  BigTradesLayer,
  CvdPaneLayer,
  ImbalanceLayer,
  MtfBoxesLayer,
  OnChartLiquidityLayer,
  VolumeHistogramLayer,
} from './flowLayers';
import { readChartTypeSettings, type ChartTypeSettings } from './settings';
import { TpoLayer, TpoModel } from './tpoLayer';
import './sessions';

/** Templates built here (the four core ones stay in buildChart.ts). */
export const EXTRA_TEMPLATES: ChartTemplateId[] = [
  'order-flow-light',
  'imbalance',
  'tpo',
  'onchart-liquidity',
  'mtf',
  'volume-histogram',
  'cot',
  'delta-profile',
];

/** False for templates whose x-axis is not the chart's bar series (indicators / drawings skip them). */
export function templateHasBars(t: ChartTemplateId): boolean {
  return t !== 'liquidity-map' && t !== 'tpo' && t !== 'cot';
}

export interface TemplateBuildCtx {
  hosts: HTMLElement[];
  store: MarketStore;
  state: ChartWindowState;
  palette: ChartPalette;
  spec: BarSpec;
  series: () => BarSeries;
  /** Creates a ChartCore on a host and registers it with the chart handle. */
  mk(host: HTMLElement, opts?: ConstructorParameters<typeof ChartCore>[3]): ChartCore;
  /** The handle's live core list (MTF panes are added / removed here). */
  cores: ChartCore[];
  unsubs: (() => void)[];
}

const lastPx = (store: MarketStore) => () => {
  const t = store.lastTrade;
  if (!t) return null;
  const prev = store.trades[store.trades.length - 2];
  return { px: t.px, up: !prev || t.px >= prev.px ? t.side !== 'sell' : false };
};

const title = (store: MarketStore, extra: () => string) => () => {
  const i = store.instrument;
  const e = extra();
  return `${i.displayName} @ ${i.exchange}${e ? ' · ' + e : ''}`;
};

/** Light palette for Order Flow (Light), whatever the app theme is. */
export const LIGHT_PALETTE: ChartPalette = toPalette(THEMES.light);

/**
 * Builds one of the additional built-in templates (P09 / P33) as layers on ChartCore.
 * Returns the in-place update function (settings changes without a rebuild).
 */
export function buildExtraTemplate(b: TemplateBuildCtx): (s: ChartWindowState) => void {
  const { store, spec, series } = b;
  let settings: ChartTypeSettings = readChartTypeSettings(b.state);
  const get = () => settings;
  const tf = specLabel(spec);
  let onUpdate: (s: ChartWindowState) => void = () => {};

  switch (b.state.template) {
    case 'order-flow-light': {
      const c = b.mk(b.hosts[0]!);
      // Light variant whatever the app theme: theme changes must not replace this palette.
      Object.defineProperty(c, 'palette', {
        get: () => LIGHT_PALETTE,
        set: () => {},
        configurable: true,
      });
      c.invalidate();
      c.slotWidth = 110;
      c.options.rightMargin = 1;
      // A narrow window still shows a few bars of context (they collapse to candles).
      c.minVisibleSlots = 3;
      c.rightOffset = 0.6;
      c.setSource(barSource(series()));
      const fp = new FootprintLayer(series, { mode: 'bidask-delta-colored' });
      const candles = new CandlesLayer(series);
      candles.strip = true;
      c.setLayers([
        new SessionSeparatorLayer(series),
        { id: 'sync', draw: (v) => (candles.strip = !fp.collapsed(v)) },
        candles,
        fp,
        new BigTradesLayer(store, series, get),
        new CvdPaneLayer(series, get),
        new LastPriceLayer(lastPx(store)),
        new LegendLayer(
          series,
          title(
            store,
            () => `${tf} · Order Flow (Light) · bubbles ≥ ${get().orderFlowLight.bigTrade}`,
          ),
        ),
      ]);
      onUpdate = (s) => {
        fp.settings.mode = s.footprintMode.startsWith('bidask')
          ? s.footprintMode
          : fp.settings.mode;
      };
      break;
    }
    case 'delta-profile': {
      const c = b.mk(b.hosts[0]!);
      c.slotWidth = 110;
      c.options.rightMargin = 1;
      // A narrow window still shows a few bars of context (they collapse to candles).
      c.minVisibleSlots = 3;
      c.rightOffset = 0.6;
      c.setSource(barSource(series()));
      const fp = new FootprintLayer(series, { mode: 'delta-profile' });
      const candles = new CandlesLayer(series);
      candles.strip = true;
      c.setLayers([
        new SessionSeparatorLayer(series),
        { id: 'sync', draw: (v) => (candles.strip = !fp.collapsed(v)) },
        candles,
        fp,
        new StatsRowsLayer(series),
        new LastPriceLayer(lastPx(store)),
        new LegendLayer(
          series,
          title(store, () => `${tf} · Delta Profile`),
        ),
      ]);
      break;
    }
    case 'imbalance': {
      const c = b.mk(b.hosts[0]!);
      c.slotWidth = 34;
      c.setSource(barSource(series()));
      const candles = new CandlesLayer(series);
      candles.mode = 'transparent';
      c.setLayers([
        new SessionSeparatorLayer(series),
        candles,
        new ImbalanceLayer(series, get),
        new VolumePaneLayer(series),
        new LastPriceLayer(lastPx(store)),
        new LegendLayer(
          series,
          title(
            store,
            () =>
              `${tf} · Imbalance ${get().imbalance.ratio}% · stacked ≥ ${get().imbalance.stacked}`,
          ),
        ),
      ]);
      break;
    }
    case 'volume-histogram': {
      const c = b.mk(b.hosts[0]!);
      c.slotWidth = 72;
      c.setSource(barSource(series()));
      c.setLayers([
        new SessionSeparatorLayer(series),
        new VolumeHistogramLayer(series, get),
        new VolumePaneLayer(series),
        new LastPriceLayer(lastPx(store)),
        new LegendLayer(
          series,
          title(store, () => `${tf} · Volume Histogram`),
        ),
      ]);
      break;
    }
    case 'onchart-liquidity': {
      const c = b.mk(b.hosts[0]!);
      c.slotWidth = 10;
      c.setSource(barSource(series()));
      c.setLayers([
        new OnChartLiquidityLayer(store, series, get),
        new SessionSeparatorLayer(series),
        new CandlesLayer(series),
        new VolumePaneLayer(series),
        new LastPriceLayer(lastPx(store), () => ({
          bid: store.book.bestBid,
          ask: store.book.bestAsk,
        })),
        new LegendLayer(
          series,
          title(store, () => `${tf} · On-Chart Liquidity Map · resting depth behind candles`),
        ),
      ]);
      break;
    }
    case 'tpo': {
      const c = b.mk(b.hosts[0]!);
      const periodSeries = () =>
        store.getSeries({
          kind: 'time',
          ms: get().tpo.periodMin * 60_000,
          session: spec.session,
        } as BarSpec);
      const autoRows = () => {
        const bars = periodSeries().bars;
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = Math.max(0, bars.length - 96); i < bars.length; i++) {
          lo = Math.min(lo, bars[i]!.l);
          hi = Math.max(hi, bars[i]!.h);
        }
        if (!Number.isFinite(lo)) return 1;
        const want = Math.max(1, Math.ceil((hi - lo) / 70));
        return (
          [1, 2, 4, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find((x) => x >= want) ?? want
        );
      };
      let rows = 0;
      let rowsKey = '';
      const rowTicks = () => {
        const s = periodSeries();
        const k = `${s.spec.kind === 'time' ? s.spec.ms : 0}|${s.bars.length}`;
        if (k !== rowsKey) {
          rowsKey = k;
          rows = autoRows();
        }
        return rows;
      };
      const model = new TpoModel(periodSeries, get, rowTicks);
      c.slotWidth = get().tpo.slotWidth;
      c.options.rightMargin = 0.4;
      c.rightOffset = 0.4;
      c.options.minSlotWidth = 40;
      c.setSource(model.source());
      c.setLayers([
        new TpoLayer(model, get),
        new LastPriceLayer(lastPx(store)),
        new LegendLayer(
          () => null,
          title(
            store,
            () =>
              `TPO ${get().tpo.periodMin} min · profile ${get().tpo.split} · VA ${get().tpo.valueAreaPct}% · IB ${get().tpo.ibPeriods} periods`,
          ),
        ),
      ]);
      let lastWidth = get().tpo.slotWidth;
      onUpdate = () => {
        if (get().tpo.slotWidth !== lastWidth) {
          lastWidth = get().tpo.slotWidth;
          c.slotWidth = lastWidth;
        }
      };
      break;
    }
    case 'cot': {
      const c = b.mk(b.hosts[0]!);
      const want = () =>
        resolveCot(get().cot, store.instrument.symbol, getSetting('data.cotReport') as CotReport);
      let cache: { entries: unknown; key: string; out: CotData } | null = null;
      const data = (): CotData => {
        const { market, report } = want();
        const entries = useCot.getState().entries;
        const key = `${market?.code ?? ''}:${report}`;
        if (!cache || cache.entries !== entries || cache.key !== key)
          cache = { entries, key, out: cotData(entries, market, report) };
        return cache.out;
      };
      /** Loads the data once per (market, report, years); weekly refresh when enabled. */
      let requested = '';
      const ensure = () => {
        const { market, report } = want();
        if (!market) return;
        const years = get().cot.years;
        const k = `${report}:${market.code}:${years}`;
        if (k === requested) return;
        requested = k;
        void useCot
          .getState()
          .load(report, market.code, years, false, !getSetting('data.cotAutoRefresh'));
      };
      c.slotWidth = 8;
      c.options.rightMargin = 2;
      c.rightOffset = 2;
      c.setSource(cotSource(data));
      const slots = [0, 1, 2, 3, 4].map((i) => new CotPaneLayer(i, data, get));
      c.setLayers([
        new CotTableLayer(data, get),
        ...slots,
        new CotPaneLayer(-1, data, get),
        new LegendLayer(
          () => null,
          () => {
            const d = data();
            const name = d.market ? `${d.market.name} (${d.market.root})` : store.instrument.symbol;
            return `COT (${d.report.toUpperCase()}, weekly) · ${name}${d.sample ? ' · SAMPLE DATA' : ''}`;
          },
        ),
      ]);
      ensure();
      b.unsubs.push(useCot.subscribe(() => c.invalidate()));
      onUpdate = () => {
        ensure();
        c.invalidate();
      };
      break;
    }
    case 'mtf': {
      onUpdate = buildMtf(b, get, tf);
      break;
    }
    default:
      break;
  }
  return (s) => {
    settings = readChartTypeSettings(s);
    onUpdate(s);
  };
}

/** Multi-timeframe chart: HTF boxes behind the candles, or 2–4 panes side by side / stacked. */
function buildMtf(b: TemplateBuildCtx, get: () => ChartTypeSettings, tf: string) {
  const { store, spec, series } = b;
  const baseMs = spec.kind === 'time' || spec.kind === 'heikin' ? spec.ms : 0;
  const host = b.hosts[0]!;
  const panesBox = document.createElement('div');
  panesBox.className = 'mtf-panes';
  panesBox.style.cssText = 'position:absolute;inset:0;';
  host.appendChild(panesBox);
  const mainHost = document.createElement('div');
  mainHost.style.cssText = 'position:absolute;';
  mainHost.dataset.testid = 'mtf-pane';
  panesBox.appendChild(mainHost);
  b.unsubs.push(() => panesBox.remove());

  const higherSpecs = () =>
    get()
      .mtf.tfs.filter((ms) => ms !== baseMs)
      .map((ms) => ({ kind: 'time', ms, session: spec.session }) as BarSpec);
  const higher = () =>
    get().mtf.layout === 'overlay'
      ? higherSpecs()
          .filter((s) => s.kind === 'time' && s.ms > baseMs)
          .sort((x, y) => (y as { ms: number }).ms - (x as { ms: number }).ms)
          .map((s) => ({ series: store.getSeries(s), label: specLabel(s) }))
      : [];

  const main = b.mk(mainHost);
  main.slotWidth = 8;
  main.setSource(barSource(series()));
  main.setLayers([
    new MtfBoxesLayer(series, higher, get),
    new SessionSeparatorLayer(series),
    new CandlesLayer(series),
    new VolumePaneLayer(series),
    new LastPriceLayer(lastPx(store)),
    new LegendLayer(
      series,
      title(store, () =>
        get().mtf.layout === 'overlay'
          ? `${tf} + ${higherSpecs()
              .map((s) => specLabel(s))
              .join(' + ')} boxes`
          : tf,
      ),
    ),
  ]);

  let extra: { core: ChartCore; el: HTMLElement; unsub: () => void }[] = [];
  let key = '';
  const layout = () => {
    const st = get().mtf;
    const k = `${st.layout}|${st.tfs.join(',')}`;
    if (k === key) return;
    key = k;
    for (const e of extra) {
      e.unsub();
      e.core.destroy();
      e.el.remove();
      const i = b.cores.indexOf(e.core);
      if (i >= 0) b.cores.splice(i, 1);
    }
    extra = [];
    const specs = st.layout === 'overlay' ? [] : higherSpecs();
    const n = 1 + specs.length;
    const place = (el: HTMLElement, i: number) => {
      const pct = 100 / n;
      el.style.left = st.layout === 'side' ? `${i * pct}%` : '0';
      el.style.top = st.layout === 'stacked' ? `${i * pct}%` : '0';
      el.style.width = st.layout === 'side' ? `calc(${pct}% - ${i < n - 1 ? 1 : 0}px)` : '100%';
      el.style.height = st.layout === 'stacked' ? `calc(${pct}% - ${i < n - 1 ? 1 : 0}px)` : '100%';
    };
    place(mainHost, 0);
    specs.forEach((sp, k) => {
      const el = document.createElement('div');
      el.style.cssText = 'position:absolute;';
      el.dataset.testid = 'mtf-pane';
      panesBox.appendChild(el);
      place(el, k + 1);
      const s = () => store.getSeries(sp);
      const core = new ChartCore(el, store.instrument, main.palette);
      core.slotWidth = 8;
      core.mouseMode = main.mouseMode;
      core.setSource(barSource(s()));
      core.setLayers([
        new SessionSeparatorLayer(s),
        new CandlesLayer(s),
        new VolumePaneLayer(s),
        new LastPriceLayer(lastPx(store)),
        new LegendLayer(
          s,
          title(store, () => specLabel(sp)),
        ),
      ]);
      b.cores.push(core);
      extra.push({ core, el, unsub: store.subscribe(() => core.invalidate()) });
    });
  };
  layout();
  b.unsubs.push(() => {
    for (const e of extra) e.unsub();
  });
  return () => layout();
}
