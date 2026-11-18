import { useEffect, useMemo, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import { ContextMenu, toast, type MenuEntry } from '@htflow/ui-kit';
import { formatPrice, specLabel, type BarSpec, type MarketStore } from '@htflow/market-data';
import type { ChartWindowState, WindowState } from '@htflow/workspace';
import type { ChartCore, HitInfo } from '@htflow/chart-engine';
import { useWindows } from '../state/windows';
import { hub, paper } from '../state/market';
import { activeAccount } from '../trading/accounts';
import { submitOrder } from '../trading/orders';
import { InstrumentPicker } from '../components/InstrumentPicker';
import { buildChart, type ChartHandle } from './buildChart';
import { usePalette } from './palette';
import { useMarketStore, useStoreTicker } from './useMarket';
import { SideTools } from './SideTools';
import { useFootprintQuick } from './FootprintQuickSettings';
import { DomTrader } from '../trading/DomView';
import { chartExtensions, type MenuAt } from './extensions';
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
import { getSetting } from '../state/settings';
import {
  DAY_MS,
  LazyHistoryGate,
  autoLoadsHistory,
  lazySpanMs,
  loadChunks,
  progressLabel,
  runBackfill,
  spanLabel,
  type BackfillEnd,
} from './history';
import { useSettingsStore } from '../state/settings';
import { onChartAction, publishCrosshair, subscribeCrosshair, type CrosshairSync } from './bus';
import { installChartCommands } from './commands';
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
import { SessionSelect } from './timeframes/TimeframeDialog';

const LOT_FILTERS = [1, 2, 5, 10, 100];
const COMPARE_COLORS = ['#4FA3F7', '#B07CF0', '#E8B04B', '#BDBDBD', '#64C8D8'];

/** Footer suffix for the automatic history state. */
function backfillNote(b: 'running' | BackfillEnd | null): string {
  if (b === 'running') return ' · loading older history…';
  if (b === 'exhausted') return ' · all available history';
  if (b === 'max-candles') return ' · max candles reached';
  return '';
}

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
  const [menuAt, setMenuAt] = useState<MenuAt | null>(null);
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
  // Automatic history: "backfilling" while the background loop runs, then why it stopped.
  const [backfill, setBackfill] = useState<'running' | BackfillEnd | null>(null);
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
    // Lazy left-scroll loading: ask the store for older history past the first bar. Gated on a
    // user scroll so coarse timeframes (few bars, always "past the start") cannot loop.
    const span = lazySpanMs(h.periodMs, store.feedKind);
    const gate = new LazyHistoryGate(main.rightOffset);
    let pending = false;
    unsubs.push(() => gate.dispose());
    unsubs.push(
      main.onScrollPastStart(() => {
        if (pending || store.loadingOlder || store.historyExhausted) return;
        if (!gate.take(main.rightOffset)) return;
        const bars = h.series()?.bars.length ?? 0;
        if (bars >= globalChartOptions().maxCandles) {
          setOlderNote('Max candles per chart reached (Settings → Common)');
          return;
        }
        if (!store.olderLoader) {
          setOlderNote('No older history from this feed');
          return;
        }
        setOlderNote(`Loading older history (${spanLabel(span)})…`);
        pending = true;
        // Let the note paint before a simulated chunk is generated.
        setTimeout(() => {
          if (gate.isDisposed) return;
          void store.loadOlder(span).then((n) => {
            pending = false;
            if (gate.isDisposed) return;
            setOlderNote(n ? null : 'Start of available history');
            main.invalidate();
          });
        }, 0);
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

  // Automatic history (replaces "Load days"): real / replay feeds backfill older history in the
  // background, as far back as the venue provides, up to Settings → Common → Max candles. Each
  // step yields to the UI; the loop stops on rebuild (timeframe change) and is step-capped.
  useEffect(() => {
    if (!store.ready || !autoLoadsHistory(store.feedKind, !!store.olderLoader)) return;
    if (getSetting('common.autoBackfill') === false) return;
    let stop = false;
    setBackfill('running');
    void runBackfill({
      periodMs: handle.current?.periodMs ?? null,
      bars: () => handle.current?.series()?.bars.length ?? 0,
      maxBars: globalChartOptions().maxCandles,
      loadOlder: (span, opts) => store.loadOlder(span, opts),
      busy: () => store.loadingOlder,
      exhausted: () => store.historyExhausted,
      stopped: () => stop,
      onStep: () => handle.current?.main.invalidate(),
    }).then((r) => {
      if (!stop) setBackfill(r.end);
    });
    return () => {
      stop = true;
    };
  }, [store, store.ready, built]);

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
    core.snapshotCanvas().toBlob((blob) => {
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
    // One day per request at most (a simulated day is ~700k ticks), with progress shown.
    const chunks = loadChunks((store.trades[0]?.ts ?? t) - t + 600_000, DAY_MS, 48);
    for (const [i, span] of chunks.entries()) {
      if ((store.trades[0]?.ts ?? Infinity) <= t || !store.olderLoader) break;
      setOlderNote(`Loading history ${i + 1}/${chunks.length}…`);
      await new Promise((r) => setTimeout(r, 0));
      const n = await store.loadOlder(Math.max(3_600_000, span));
      if (!n) break;
    }
    setOlderNote(null);
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
            // Explicit request (palette / hot key): one more day before the first bar.
            store.historyExhausted = false;
            setOlderNote('Loading older history…');
            void store
              .loadOlder(DAY_MS)
              .then((n) => {
                setOlderNote(null);
                handle.current?.cores.forEach((c) => c.invalidate());
                return n;
              })
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

  // Right-click Buy / Sell: the account picked in the Trading Panel and its selected ATM bracket.
  const order = (side: 'buy' | 'sell', type: 'limit' | 'stop') => {
    if (menuPx === null) return;
    const px = menuPx;
    void submitOrder({
      accountId: activeAccount(),
      instrumentId: inst.id,
      side,
      type,
      qty: s.lots || 1,
      px: type === 'limit' ? px : undefined,
      stopPx: type === 'stop' ? px : undefined,
    }).then((o) => {
      if (o && o.status !== 'rejected')
        toast(
          'success',
          `${side === 'buy' ? 'Buy' : 'Sell'} ${type} ${s.lots || 1} @ ${formatPrice(px, inst)}`,
          `${paper.accounts.get(o.accountId)?.name ?? o.accountId}${o.atm ? ` · ATM ${o.atm}` : ''}`,
        );
    });
  };
  const lockAccount = () => paper.route(activeAccount(), inst.id);

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
        locked: !!paper.accounts.get(lockAccount())?.locked,
        toggleLock: () => {
          const acc = lockAccount();
          paper.setLocked(acc, !paper.accounts.get(acc)?.locked);
        },
        extensionItems: chartExtensions().flatMap((e) => {
          const ctx = handle.current?.extCtx.get(e.id);
          return ctx && e.menu ? e.menu(ctx, menuPx, menuAt ?? undefined) : [];
        }),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [menuPx, hit, menuAt, s, settings, domTrader, lib, built],
  );

  const capture = (e: React.MouseEvent) => {
    const h = handle.current;
    const core: ChartCore | undefined =
      h?.cores.find((c) => c.canvas === e.target) ?? h?.cores[h.cores.length - 1];
    const v = core?.view;
    if (core && v) {
      const r = core.canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const hi = core.hitTest(x, y);
      setHit(hi);
      setMenuAt({ x, y, hit: hi, core });
    } else {
      setHit({ area: 'plot' });
      setMenuAt(null);
    }
    // Price at the cursor: the right (price-axis) core for Order Flow.
    // Without a crosshair yet (right-click straight after moving), use the price at the pointer.
    const pcore = h?.cores[h.cores.length - 1];
    const pc = pcore?.view;
    let px = pc?.crosshair ? pc.crosshair.px : (v?.crosshair?.px ?? null);
    if (px === null && pcore && pc) {
      const y = e.clientY - pcore.canvas.getBoundingClientRect().top;
      if (y >= pc.plot.y && y < pc.plot.y + pc.plot.h) px = Math.round(pc.pxAt(y));
    }
    setMenuPx(px);
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
            onSettings={() => useFootprintQuick.getState().open(id)}
          />
        )}
        <ContextMenu items={menu}>
          <div
            ref={hostsRef}
            className={isSplit ? 'chart-hosts split' : 'chart-hosts'}
            dir="ltr"
            onContextMenu={capture}
            onDoubleClick={(e) => {
              if (e.ctrlKey) fullscreen();
            }}
            data-testid={`chart-${s.template}`}
          >
            {!store.ready && (
              <div className="chart-loading" data-testid="chart-loading" role="status">
                {!store.error && <span className="chart-loading-spin" aria-hidden />}
                {store.error ?? `Loading ${inst.symbol}…`}
              </div>
            )}
            {store.ready && backfill === 'running' && (
              <div
                className="chart-backfill"
                data-testid="chart-backfill"
                role="status"
                title="Loading older history in the background"
              >
                <span className="chart-loading-spin" aria-hidden /> history
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
            <PrevSessionProbe handle={handle} store={store} />
            <BarsProbe handle={handle} store={store} />
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
          <SessionSelect windowId={id} s={s} />
          <button
            className="ht-chip ht-chip--ghost"
            aria-label="Go to date"
            title="Go to date (Ctrl+G)"
            onClick={() => setGotoOpen(true)}
          >
            📅
          </button>
          <span className="muted" data-testid="history-range">
            {(store.historyProgress && progressLabel(store.historyProgress)) ??
              olderNote ??
              (s.template === 'liquidity-map'
                ? `Brightness 100 · Cut-off 98/20 · ${store.depth.length} columns`
                : `History ${spanLabel(store.trades.length ? store.lastTs - store.trades[0]!.ts : 0)} · ${store.trades.length.toLocaleString()} ticks${backfillNote(backfill)}`)}
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

/** Accessible mirror of the previous-session profile (screen readers, tests). */
function PrevSessionProbe({
  handle,
  store,
}: {
  handle: React.MutableRefObject<ChartHandle | null>;
  store: MarketStore;
}) {
  useStoreTicker(store, 1);
  const last = handle.current?.layers.prevProfile?.last ?? null;
  return (
    <span
      className="chart-sr"
      data-testid="prev-session-profile"
      data-poc={last ? formatPrice(last.poc, store.instrument) : ''}
    >
      {last
        ? `Previous session POC ${formatPrice(last.poc, store.instrument)}, value area ${formatPrice(last.val, store.instrument)}–${formatPrice(last.vah, store.instrument)}`
        : 'No previous session loaded'}
    </span>
  );
}

/** Accessible bar count of the main series (screen readers, tests). */
function BarsProbe({
  handle,
  store,
}: {
  handle: React.MutableRefObject<ChartHandle | null>;
  store: MarketStore;
}) {
  useStoreTicker(store, 1);
  const n = handle.current?.series()?.bars.length ?? 0;
  return (
    <span className="chart-sr" data-testid="chart-bars" data-count={n}>
      {`${n} bars`}
    </span>
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
