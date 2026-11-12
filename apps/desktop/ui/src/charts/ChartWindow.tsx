import { useEffect, useMemo, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import { ContextMenu, Select, toast, type MenuEntry } from '@htflow/ui-kit';
import { specLabel, type BarSpec, type MarketStore } from '@htflow/market-data';
import type { ChartWindowState, WindowState } from '@htflow/workspace';
import type { ChartCore, HitInfo } from '@htflow/chart-engine';
import { useWindows } from '../state/windows';
import { hub, paper, PAPER_ACCOUNT } from '../state/market';
import { InstrumentPicker } from '../components/InstrumentPicker';
import { buildChart, type ChartHandle } from './buildChart';
import { usePalette } from './palette';
import { useMarketStore, useStoreTicker } from './useMarket';
import { SideTools } from './SideTools';
import { DomTrader } from '../trading/DomView';
import { chartExtensions } from './extensions';
import { applyChartSettings } from './settings/apply';
import { normalizeSettings, sBool, sStr, type ChartSettings } from './settings/schema';
import {
  baseSettings,
  extState,
  patchChartExt,
  setChartSetting,
  type CompareItem,
} from './settings/state';
import { globalChartOptions } from './settings/globals';
import { useSettingsStore } from '../state/settings';
import { onChartAction, publishCrosshair, subscribeCrosshair, type CrosshairSync } from './bus';
import { installChartCommands, openChartSettings } from './commands';
import { buildChartMenu } from './menu';
import { DataWindow, GoToDateDialog, SaveTemplateDialog } from './panels';
import { barsCsv, barsJson, clustersCsv } from './exportData';
import {
  downloadText,
  saveTemplateFrom,
  applyTemplateTo,
  useChartTemplates,
} from './templateStore';
import {
  ASSET_CLASSES,
  defaultFor,
  makeTemplate,
  serializeTemplates,
  setClassDefault,
} from './templates';
import './chart-core.css';

installChartCommands();

const LOT_FILTERS = [1, 2, 5, 10, 100];
const COMPARE_COLORS = ['#4FA3F7', '#B07CF0', '#E8B04B', '#BDBDBD', '#64C8D8'];

export function ChartWindow(props: IDockviewPanelProps) {
  const id = props.api.id;
  const s = useWindows((st) => st.windows[id]) as ChartWindowState | undefined;
  if (!s || s.kind !== 'chart') return null;
  return <ChartBody id={id} s={s} />;
}

/** Retains compare-instrument stores while they are overlaid. */
function useCompareStores(items: CompareItem[]): Map<string, MarketStore> {
  const key = items.map((i) => i.instrumentId).join('|');
  const stores = useMemo(() => {
    const m = new Map<string, MarketStore>();
    for (const i of items) m.set(i.instrumentId, hub.ensure(i.instrumentId));
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    const ids = [...stores.keys()];
    ids.forEach((i) => hub.retain(i));
    return () => ids.forEach((i) => hub.release(i));
  }, [stores]);
  return stores;
}

function ChartBody({ id, s }: { id: string; s: ChartWindowState }) {
  const patch = useWindows((st) => st.patch);
  const set = (p: Partial<ChartWindowState>) => patch(id, p as Partial<WindowState>);
  const store = useMarketStore(s.instrumentId);
  useStoreTicker(store, 2);
  const palette = usePalette();
  const rootRef = useRef<HTMLDivElement>(null);
  const hostsRef = useRef<HTMLDivElement>(null);
  const hostA = useRef<HTMLDivElement>(null);
  const hostB = useRef<HTMLDivElement>(null);
  const handle = useRef<ChartHandle | null>(null);
  const [built, setBuilt] = useState(0);
  const [rebuild, setRebuild] = useState(0);
  const [domTrader, setDomTrader] = useState(false);
  const [menuPx, setMenuPx] = useState<number | null>(null);
  const [hit, setHit] = useState<HitInfo>({ area: 'plot' });
  const [compact, setCompact] = useState(false);
  const [gotoOpen, setGotoOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [picker, setPicker] = useState<null | 'instrument' | 'overlay'>(null);
  const [olderNote, setOlderNote] = useState<string | null>(null);
  const tfKey = JSON.stringify(s.timeframe);
  const isSplit = s.template === 'order-flow-dark';
  const ext = extState(s);
  const settingsKey = JSON.stringify(ext.settings ?? {});
  // Global Settings → Chart / Footprint act as defaults under the chart's own values.
  const globals = useSettingsStore((st) => st.values);
  const settings: ChartSettings = useMemo(
    () => normalizeSettings(ext.settings, baseSettings()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settingsKey, globals],
  );
  const panesKey = JSON.stringify(ext.panes ?? {});
  const compare = useMemo(() => ext.compare ?? [], [JSON.stringify(ext.compare ?? [])]); // eslint-disable-line react-hooks/exhaustive-deps
  const compareStores = useCompareStores(compare);
  const prevApplied = useRef<ChartSettings | null>(null);
  const lib = useChartTemplates((st) => st.lib);
  const inst = store.instrument;
  const linkRef = useRef(s.link);
  linkRef.current = s.link;
  const instRef = useRef(s.instrumentId);
  instRef.current = s.instrumentId;
  const syncRef = useRef<CrosshairSync>('off');
  syncRef.current = sStr(settings, 'crosshair.sync') as CrosshairSync;

  // Rebuild only when structure changes; mode / filters / settings update in place.
  useEffect(() => {
    if (!store.ready || !hostA.current) return;
    const hosts = [hostA.current, ...(hostB.current ? [hostB.current] : [])];
    const h = buildChart(hosts, store, s, palette, {
      windowId: id,
      setExt: (extId, value) => {
        const cur = useWindows.getState().windows[id];
        if (cur?.kind !== 'chart') return;
        patch(id, { ext: { ...(cur.ext ?? {}), [extId]: value } } as Partial<WindowState>);
      },
    });
    handle.current = h;
    prevApplied.current = null;
    const main = h.main;
    const unsubs: (() => void)[] = [];
    // Crosshair sync (P08): publish ours, show others'.
    unsubs.push(
      main.onCrosshairMove((pt) =>
        publishCrosshair(id, syncRef.current, linkRef.current, instRef.current, pt),
      ),
      subscribeCrosshair({
        windowId: id,
        link: () => linkRef.current,
        instrumentId: () => instRef.current,
        fn: (pt, same) => main.setExternalCrosshair(pt, same),
      }),
    );
    // Pane heights persist in the window state.
    let paneTimer: ReturnType<typeof setTimeout> | null = null;
    unsubs.push(
      main.onPaneResize((layerId, hh) => {
        if (paneTimer) clearTimeout(paneTimer);
        paneTimer = setTimeout(() => {
          const cur = useWindows.getState().windows[id];
          if (cur?.kind !== 'chart') return;
          const panes = layerId === '*' ? {} : { ...(extState(cur).panes ?? {}), [layerId]: hh };
          patchChartExt(id, { panes });
        }, 250);
      }),
    );
    // Lazy left-scroll loading: ask the store for older history past the first bar.
    const span = Math.max(3_600_000, (h.periodMs ?? 60_000) * 240);
    unsubs.push(
      main.onScrollPastStart(() => {
        if (store.loadingOlder || store.historyExhausted) return;
        const bars = h.series()?.bars.length ?? 0;
        if (bars >= globalChartOptions().maxCandles) {
          setOlderNote('Max candles per chart reached (Settings → Common)');
          return;
        }
        if (!store.olderLoader) {
          setOlderNote('No older history from this feed');
          return;
        }
        setOlderNote('Loading older history…');
        void store.loadOlder(span).then((n) => {
          setOlderNote(n ? null : 'Start of available history');
          main.invalidate();
        });
      }),
    );
    setBuilt((x) => x + 1);
    return () => {
      unsubs.forEach((u) => u());
      if (paneTimer) clearTimeout(paneTimer);
      h.dispose();
      handle.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, store.ready, s.template, tfKey, s.heatColumnMs, isSplit, rebuild]);

  useEffect(() => handle.current?.update(s), [s]);

  // Chart settings (P34) apply live.
  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    applyChartSettings(h, settings, {
      store,
      palette,
      symbol: `${inst.symbol} · ${specLabel(s.timeframe as BarSpec)}`,
      isReplay: s.instrumentId.startsWith('replay:'),
      prev: prevApplied.current,
      panes: ext.panes,
    });
    prevApplied.current = settings;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, palette, built, panesKey]);

  // Compare / overlay instruments.
  useEffect(() => {
    const layer = handle.current?.layers.compare;
    if (!layer) return;
    const spec = s.timeframe as BarSpec;
    layer.items = compare.map((c) => {
      const st = compareStores.get(c.instrumentId);
      return {
        id: c.instrumentId,
        label: st?.instrument.symbol ?? c.instrumentId,
        color: c.color,
        series: () => (st?.ready ? st.getSeries(spec) : null),
      };
    });
    const unsubs = [...compareStores.values()].map((st) =>
      st.subscribe(() => handle.current?.main.invalidate()),
    );
    handle.current?.main.invalidate();
    return () => unsubs.forEach((u) => u());
  }, [compare, compareStores, built, tfKey, s.timeframe]);

  // Bar countdown ticks once per second.
  const countdown = sBool(settings, 'price.countdown');
  useEffect(() => {
    if (!countdown) return;
    const t = setInterval(() => handle.current?.cores.forEach((c) => c.invalidate()), 1000);
    return () => clearInterval(t);
  }, [countdown]);

  // Default template per instrument class when the instrument changes.
  const prevInst = useRef(s.instrumentId);
  useEffect(() => {
    if (prevInst.current === s.instrumentId) return;
    prevInst.current = s.instrumentId;
    const L = useChartTemplates.getState().lib;
    if (!L.applyOnInstrumentChange) return;
    const t = defaultFor(L, inst.assetClass);
    if (t) applyTemplateTo(id, t.id);
  }, [s.instrumentId, id, inst.assetClass]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setCompact(el.clientHeight < 520));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const snapshot = () => {
    const core = handle.current?.cores[handle.current.cores.length - 1];
    if (!core) return;
    core.canvas.toBlob((blob) => {
      if (!blob) return;
      const item =
        typeof ClipboardItem !== 'undefined' ? new ClipboardItem({ 'image/png': blob }) : null;
      if (item && navigator.clipboard?.write)
        void navigator.clipboard.write([item]).then(() => toast('success', 'Chart copied as PNG'));
      else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `htflow-${store.instrument.symbol}.png`;
        a.click();
      }
    });
  };

  useEffect(() => {
    const onSnap = (e: Event) => {
      if ((e as CustomEvent).detail === id) snapshot();
    };
    window.addEventListener('htflow:snapshot', onSnap);
    return () => window.removeEventListener('htflow:snapshot', onSnap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, store]);

  const goToTime = async (t: number) => {
    const h = handle.current;
    if (!h) return;
    let guard = 0;
    while ((store.trades[0]?.ts ?? Infinity) > t && store.olderLoader && guard++ < 48) {
      const n = await store.loadOlder(
        Math.max(3_600_000, (store.trades[0]?.ts ?? t) - t + 600_000),
      );
      if (!n) break;
    }
    if (!h.main.scrollToTime(t)) toast('warning', 'Date is before the available history');
  };

  const fullscreen = () => {
    const el = rootRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.().catch(() => toast('error', 'Full screen is not available'));
  };

  const bars = () => handle.current?.series()?.bars ?? [];
  const fileBase = `${inst.symbol}-${specLabel(s.timeframe as BarSpec)}`.replace(/[^\w.-]+/g, '_');

  // Chart actions from the menu, commands and hotkeys.
  useEffect(
    () =>
      onChartAction(id, (a) => {
        switch (a) {
          case 'goto-date':
            return setGotoOpen(true);
          case 'change-instrument':
            return setPicker('instrument');
          case 'overlay':
            return setPicker('overlay');
          case 'clear-overlays':
            return patchChartExt(id, { compare: [] });
          case 'save-template':
            return setSaveOpen(true);
          case 'refresh':
            setRebuild((x) => x + 1);
            return toast('info', 'Chart refreshed');
          case 'reload-history':
            store.historyExhausted = false;
            store.rebuildSeries();
            setOlderNote(null);
            return toast(
              'info',
              'Historical data reloaded',
              `${store.trades.length.toLocaleString()} ticks`,
            );
          case 'load-older':
            store.historyExhausted = false;
            void store
              .loadOlder()
              .then((n) =>
                toast(
                  'info',
                  n ? `Loaded ${n.toLocaleString()} older ticks` : 'No older history available',
                ),
              );
            return;
          case 'export-png':
            return snapshot();
          case 'export-csv':
            return downloadText(`${fileBase}-bars.csv`, barsCsv(bars(), inst), 'text/csv');
          case 'export-clusters':
            return downloadText(`${fileBase}-clusters.csv`, clustersCsv(bars(), inst), 'text/csv');
          case 'export-json':
            return downloadText(`${fileBase}-bars.json`, barsJson(bars(), inst));
          case 'export-template': {
            const cur = useWindows.getState().windows[id];
            if (cur?.kind !== 'chart') return;
            return downloadText(
              `${fileBase}.httemplate`,
              serializeTemplates([makeTemplate(fileBase, cur)]),
            );
          }
          case 'fullscreen':
            return fullscreen();
          case 'reset':
            return handle.current?.cores.forEach((c) => c.reset());
          case 'clone':
            return;
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, store, inst, fileBase],
  );

  const order = (side: 'buy' | 'sell', type: 'limit' | 'stop') => {
    if (menuPx === null) return;
    const o = paper.place({
      accountId: PAPER_ACCOUNT,
      instrumentId: inst.id,
      side,
      type,
      qty: s.lots,
      px: type === 'limit' ? menuPx : undefined,
      stopPx: type === 'stop' ? menuPx : undefined,
    });
    if (o.status === 'rejected') toast('error', 'Order rejected', o.reason);
    else
      toast(
        'success',
        `${side === 'buy' ? 'Buy' : 'Sell'} ${type} ${s.lots} @ ${menuPx}`,
        o.status,
      );
  };

  const menu: MenuEntry[] = useMemo(
    () =>
      buildChartMenu({
        windowId: id,
        state: s,
        settings,
        ext,
        store,
        hit,
        menuPx,
        lib,
        domTrader,
        handle: handle.current,
        toggleDomTrader: () => setDomTrader((x) => !x),
        order,
        extensionItems: chartExtensions().flatMap((e) => {
          const ctx = handle.current?.extCtx.get(e.id);
          return ctx && e.menu ? e.menu(ctx, menuPx) : [];
        }),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [menuPx, hit, s, settings, domTrader, lib, built],
  );

  const capture = (e: React.MouseEvent) => {
    const h = handle.current;
    const core: ChartCore | undefined =
      h?.cores.find((c) => c.canvas === e.target) ?? h?.cores[h.cores.length - 1];
    const v = core?.view;
    if (core && v) {
      const r = core.canvas.getBoundingClientRect();
      setHit(core.hitTest(e.clientX - r.left, e.clientY - r.top));
    } else setHit({ area: 'plot' });
    // Price at the cursor: the right (price-axis) core for Order Flow.
    const pc = h?.cores[h.cores.length - 1]?.view;
    setMenuPx(pc?.crosshair ? pc.crosshair.px : (v?.crosshair?.px ?? null));
  };

  const hidePanels = sBool(settings, 'other.hidePanels');
  const hideSide = hidePanels || sBool(settings, 'other.hideFootprintPanel');
  const showData = sBool(settings, 'crosshair.dataWindow');
  const clsLabel = ASSET_CLASSES.find((c) => c.value === inst.assetClass)?.label ?? inst.assetClass;

  return (
    <div
      ref={rootRef}
      className="chart-window"
      data-window-id={id}
      onFocus={() => useWindows.getState().setActive(id)}
      onMouseDown={() => useWindows.getState().setActive(id)}
    >
      <div className="chart-main">
        {!hideSide && (
          <SideTools
            windowId={id}
            mode={s.footprintMode}
            onMode={(m) =>
              set({
                footprintMode: m,
                template: s.template === 'candles-vp' ? 'footprint' : s.template,
              })
            }
            showFootprint
            compact={compact}
            onSettings={() => openChartSettings(id)}
          />
        )}
        <ContextMenu items={menu}>
          <div
            ref={hostsRef}
            className={isSplit ? 'chart-hosts split' : 'chart-hosts'}
            onContextMenu={capture}
            onDoubleClick={(e) => {
              if (e.ctrlKey) fullscreen();
            }}
            data-testid={`chart-${s.template}`}
          >
            {!store.ready && (
              <div className="chart-loading">
                {store.error ?? `Loading ${inst.symbol} history…`}
              </div>
            )}
            <div ref={hostA} className="chart-host" />
            {isSplit && <div ref={hostB} className="chart-host" />}
            {chartExtensions().map((e) =>
              e.Overlay ? <e.Overlay key={e.id} windowId={id} state={s} /> : null,
            )}
            {(s.template === 'liquidity-map' || s.template === 'order-flow-dark') && (
              <div
                className={`lots-filter ${isSplit ? 'lots-filter--split' : ''}`}
                role="radiogroup"
                aria-label="Lots filter"
              >
                <div className="lots-filter-title">Lots ≥</div>
                {LOT_FILTERS.map((n) => (
                  <button
                    key={n}
                    role="radio"
                    aria-checked={s.minLots === n}
                    onClick={() => set({ minLots: n })}
                  >
                    {n}
                  </button>
                ))}
              </div>
            )}
            {ext.pinned && (
              <span
                className="chart-pin-badge"
                title="Pinned: keeps its instrument when the link group changes"
              >
                Pinned
              </span>
            )}
          </div>
        </ContextMenu>
        {showData && (
          <DataWindow
            core={handle.current?.main ?? null}
            series={() => handle.current?.series() ?? null}
            store={store}
            onClose={() => setChartSetting(id, 'crosshair.dataWindow', false)}
            formatTime={(t) =>
              handle.current?.main.formatCrosshairTime(t) ?? new Date(t).toISOString()
            }
          />
        )}
        {domTrader && <DomTrader instrumentId={s.instrumentId} lots={s.lots} />}
      </div>
      {sBool(settings, 'other.scrollbar') && !hidePanels && (
        <ChartScrollbar handle={handle} store={store} />
      )}
      {!hidePanels && (
        <div className="chart-bottom">
          <button
            className="ht-chip ht-chip--ghost"
            onClick={() => handle.current?.cores.forEach((c) => c.reset())}
            title="Go to latest"
          >
            ◂▸
          </button>
          <Select
            small
            aria-label="Trading session"
            value={sStr(settings, 'session.trading')}
            onChange={(v) => setChartSetting(id, 'session.trading', v)}
            options={[
              { value: '24h', label: '24h' },
              { value: 'eth', label: 'ETH' },
              { value: 'rth', label: 'RTH' },
              { value: 'custom', label: 'Custom' },
            ]}
          />
          <button
            className="ht-chip ht-chip--ghost"
            aria-label="Go to date"
            title="Go to date (Ctrl+G)"
            onClick={() => setGotoOpen(true)}
          >
            📅
          </button>
          <span className="muted">
            {olderNote ??
              (s.template === 'liquidity-map'
                ? `Brightness 100 · Cut-off 98/20 · ${store.depth.length} columns`
                : `History ${Math.round((store.trades.length ? store.lastTs - store.trades[0]!.ts : 0) / 3_600_000)} h · ${store.trades.length.toLocaleString()} ticks`)}
          </span>
          <div className="grow" />
          {sBool(settings, 'delays.show') && <DelayChip store={store} settings={settings} />}
          <button
            className="ht-chip ht-chip--ghost"
            aria-pressed={showData}
            onClick={() => setChartSetting(id, 'crosshair.dataWindow', !showData)}
          >
            Data window
          </button>
          <button
            className="ht-chip ht-chip--ghost"
            aria-pressed={domTrader}
            onClick={() => setDomTrader((x) => !x)}
          >
            DOM Trader
          </button>
          <button
            className="ht-chip ht-chip--ghost"
            onClick={() =>
              useWindows.getState().setTradingPanel(!useWindows.getState().tradingPanel)
            }
          >
            Trading Panel
          </button>
        </div>
      )}
      <GoToDateDialog
        open={gotoOpen}
        onOpenChange={setGotoOpen}
        firstTime={store.trades[0]?.ts ?? 0}
        lastTime={store.lastTs}
        onGo={goToTime}
      />
      <SaveTemplateDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        className={clsLabel}
        onSave={(name, def) => {
          const t = saveTemplateFrom(id, name);
          if (t && def)
            useChartTemplates.getState().update((l) => setClassDefault(l, inst.assetClass, t.id));
          if (t) patchChartExt(id, { templateId: t.id });
        }}
      />
      {picker && (
        <InstrumentPicker
          anchor={hostsRef.current}
          value={picker === 'instrument' ? s.instrumentId : undefined}
          mode="open"
          onClose={() => setPicker(null)}
          onPick={(_e, feedId) => {
            if (!feedId) return;
            if (picker === 'instrument') set({ instrumentId: feedId });
            else if (feedId !== s.instrumentId && !compare.some((c) => c.instrumentId === feedId))
              patchChartExt(id, {
                compare: [
                  ...compare,
                  {
                    instrumentId: feedId,
                    color: COMPARE_COLORS[compare.length % COMPARE_COLORS.length]!,
                  },
                ],
              });
            setPicker(null);
          }}
        />
      )}
    </div>
  );
}

/** Feed latency chip coloured by the Data delays settings. */
function DelayChip({ store, settings }: { store: MarketStore; settings: ChartSettings }) {
  const test = sBool(settings, 'delays.test');
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    if (!test) return;
    const t = setInterval(() => setPhase((x) => (x + 1) % 3), 1200);
    return () => clearInterval(t);
  }, [test]);
  const ms = store.status.latencyMs;
  const warn = Number(settings['delays.warnMs']);
  const crit = Number(settings['delays.critMs']);
  const level = test ? phase : ms >= crit ? 2 : ms >= warn ? 1 : 0;
  const keys = [
    ['delays.goodBg', 'delays.goodText'],
    ['delays.warnBg', 'delays.warnText'],
    ['delays.critBg', 'delays.critText'],
  ][level]!;
  return (
    <span
      className="chart-delay tnum"
      title="Feed delay (Chart settings → Data delays)"
      style={{ background: sStr(settings, keys[0]!), color: sStr(settings, keys[1]!) }}
    >
      {test ? ['Good', 'Warning', 'Critical'][phase] : `${Math.round(ms)} ms`}
    </span>
  );
}

/** Horizontal scroll bar under the chart (Chart settings → Other). */
function ChartScrollbar({
  handle,
  store,
}: {
  handle: React.MutableRefObject<ChartHandle | null>;
  store: MarketStore;
}) {
  useStoreTicker(store, 4);
  const core = handle.current?.main;
  const n = core?.source.count() ?? 0;
  const value = core ? Math.round(-core.rightOffset) : 0;
  return (
    <input
      type="range"
      className="chart-scrollbar"
      aria-label="Scroll chart"
      min={-(core?.options.rightMargin ?? 0) - 1}
      max={Math.max(1, n)}
      value={value}
      onChange={(e) => {
        if (!core) return;
        core.rightOffset = -Number(e.target.value);
        core.invalidate();
      }}
    />
  );
}
