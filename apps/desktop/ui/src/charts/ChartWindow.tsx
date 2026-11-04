import { useEffect, useMemo, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import {
  Button,
  Checkbox,
  ContextMenu,
  Dialog,
  Field,
  NumberInput,
  Select,
  toast,
  type MenuEntry,
} from '@htflow/ui-kit';
import { formatPrice } from '@htflow/market-data';
import { FOOTPRINT_MODES, type FootprintSettings } from '@htflow/footprint';
import type { ChartWindowState, WindowState } from '@htflow/workspace';
import type { CandleMode, MouseMode } from '@htflow/chart-engine';
import { useWindows } from '../state/windows';
import { paper, PAPER_ACCOUNT } from '../state/market';
import { buildChart, type ChartHandle } from './buildChart';
import { usePalette } from './palette';
import { useMarketStore, useStoreTicker } from './useMarket';
import { SideTools } from './SideTools';
import { DomTrader } from '../trading/DomView';
import { chartExtensions } from './extensions';

const LOT_FILTERS = [1, 2, 5, 10, 100];

export function ChartWindow(props: IDockviewPanelProps) {
  const id = props.api.id;
  const s = useWindows((st) => st.windows[id]) as ChartWindowState | undefined;
  if (!s || s.kind !== 'chart') return null;
  return <ChartBody id={id} s={s} />;
}

function ChartBody({ id, s }: { id: string; s: ChartWindowState }) {
  const patch = useWindows((st) => st.patch);
  const set = (p: Partial<ChartWindowState>) => patch(id, p as Partial<WindowState>);
  const store = useMarketStore(s.instrumentId);
  useStoreTicker(store, 2);
  const palette = usePalette();
  const hostA = useRef<HTMLDivElement>(null);
  const hostB = useRef<HTMLDivElement>(null);
  const handle = useRef<ChartHandle | null>(null);
  const [fpSettings, setFpSettings] = useState(false);
  const [domTrader, setDomTrader] = useState(false);
  const [menuPx, setMenuPx] = useState<number | null>(null);
  const [mouseMode, setMouseMode] = useState<MouseMode>('crosshair');
  const [candleMode, setCandleMode] = useState<CandleMode>('candles');
  const [compact, setCompact] = useState(false);
  const tfKey = JSON.stringify(s.timeframe);
  const isSplit = s.template === 'order-flow-dark';

  // Rebuild only when structure changes; mode / filters update in place (< 50 ms switch).
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
    h.cores.forEach((c) => (c.mouseMode = mouseMode));
    return () => {
      h.dispose();
      handle.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, store.ready, s.template, tfKey, s.heatColumnMs, isSplit]);

  useEffect(() => handle.current?.update(s), [s]);
  useEffect(() => handle.current?.cores.forEach((c) => c.setPalette(palette)), [palette]);
  useEffect(() => handle.current?.cores.forEach((c) => (c.mouseMode = mouseMode)), [mouseMode]);
  useEffect(() => {
    handle.current?.cores.forEach((c) =>
      c.layers.forEach((l) => {
        if (l.id === 'candles') (l as unknown as { mode: CandleMode }).mode = candleMode;
      }),
    );
    handle.current?.cores.forEach((c) => c.invalidate());
  }, [candleMode]);

  useEffect(() => {
    const el = hostA.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setCompact(el.clientHeight < 520));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onSnap = (e: Event) => {
      if ((e as CustomEvent).detail !== id) return;
      const core = handle.current?.cores[handle.current.cores.length - 1];
      if (!core) return;
      core.canvas.toBlob((blob) => {
        if (!blob) return;
        const item =
          typeof ClipboardItem !== 'undefined' ? new ClipboardItem({ 'image/png': blob }) : null;
        if (item && navigator.clipboard?.write)
          void navigator.clipboard
            .write([item])
            .then(() => toast('success', 'Chart copied as PNG'));
        else {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `htflow-${store.instrument.symbol}.png`;
          a.click();
        }
      });
    };
    window.addEventListener('htflow:snapshot', onSnap);
    return () => window.removeEventListener('htflow:snapshot', onSnap);
  }, [id, store]);

  const inst = store.instrument;
  const priceLabel = menuPx !== null ? formatPrice(menuPx, inst) : '';
  const last = store.lastTrade?.px ?? store.book.mid;
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
        `${side === 'buy' ? 'Buy' : 'Sell'} ${type} ${s.lots} @ ${priceLabel}`,
        o.status,
      );
  };
  const above = menuPx !== null && menuPx > last;
  const menu: MenuEntry[] = useMemo(
    () => [
      above
        ? { id: 'sl', label: `Sell Limit at ${priceLabel}`, onSelect: () => order('sell', 'limit') }
        : { id: 'bl', label: `Buy Limit at ${priceLabel}`, onSelect: () => order('buy', 'limit') },
      above
        ? { id: 'bs', label: `Buy Stop at ${priceLabel}`, onSelect: () => order('buy', 'stop') }
        : { id: 'ss', label: `Sell Stop at ${priceLabel}`, onSelect: () => order('sell', 'stop') },
      { id: 'alert', label: `Set alert at ${priceLabel} (P23)`, disabled: true },
      { kind: 'separator', id: 's1' },
      {
        id: 'tp',
        label: 'Trading Panel',
        shortcut: 'T',
        onSelect: () => useWindows.getState().setTradingPanel(!useWindows.getState().tradingPanel),
      },
      {
        id: 'domt',
        label: 'DOM Trader',
        checked: domTrader,
        onSelect: () => setDomTrader((x) => !x),
      },
      { kind: 'separator', id: 's2' },
      {
        kind: 'submenu',
        id: 'mode',
        label: 'Mode',
        items: [
          {
            kind: 'submenu',
            id: 'fp',
            label: 'Footprint',
            items: FOOTPRINT_MODES.map((m) => ({
              id: m.id,
              label: m.label,
              shortcut: m.shortcut,
              checked: s.template === 'footprint' && s.footprintMode === m.id,
              onSelect: () => set({ template: 'footprint', footprintMode: m.id }),
            })),
          },
          ...(
            [
              ['bars', 'Bars', 'Shift+B'],
              ['candles', 'Candles', 'Shift+C'],
              ['transparent', 'Transparent candles', 'Shift+T'],
              ['line', 'Line Chart', 'Shift+L'],
              ['area', 'Area', 'Shift+M'],
              ['hidden', 'Hidden', 'Shift+H'],
            ] as [CandleMode, string, string][]
          ).map(([m, label, sc]) => ({
            id: m,
            label,
            shortcut: sc,
            checked: candleMode === m,
            onSelect: () => setCandleMode(m),
          })),
        ],
      },
      {
        kind: 'submenu',
        id: 'mouse',
        label: 'Mouse',
        items: (
          [
            ['pointer', 'Pointer'],
            ['crosshair', 'Crosshair'],
            ['zoom', 'Zoom'],
            ['scroll', 'Scroll'],
            ['zoomxy', 'ZoomXY'],
          ] as [MouseMode, string][]
        ).map(([m, label]) => ({
          id: m,
          label,
          checked: mouseMode === m,
          onSelect: () => setMouseMode(m),
        })),
      },
      {
        id: 'reset',
        label: 'Reset',
        shortcut: 'Ctrl+R',
        onSelect: () => handle.current?.cores.forEach((c) => c.reset()),
      },
      {
        id: 'png',
        label: 'Export… PNG',
        onSelect: () => window.dispatchEvent(new CustomEvent('htflow:snapshot', { detail: id })),
      },
      ...chartExtensions().flatMap((e) => {
        const ctx = handle.current?.extCtx.get(e.id);
        return ctx && e.menu ? e.menu(ctx, menuPx) : [];
      }),
      { kind: 'separator', id: 's3' },
      { id: 'settings', label: 'Settings… (P34)', shortcut: 'Ctrl+S', disabled: true },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [menuPx, priceLabel, above, s, domTrader, candleMode, mouseMode],
  );

  const capturePx = () => {
    const core = handle.current?.cores[handle.current.cores.length - 1];
    const v = core?.view;
    setMenuPx(v?.crosshair ? v.crosshair.px : null);
  };

  return (
    <div
      className="chart-window"
      onFocus={() => useWindows.getState().setActive(id)}
      onMouseDown={() => useWindows.getState().setActive(id)}
    >
      <div className="chart-main">
        <SideTools
          mode={s.footprintMode}
          onMode={(m) =>
            set({
              footprintMode: m,
              template: s.template === 'candles-vp' ? 'footprint' : s.template,
            })
          }
          showFootprint
          compact={compact}
          onSettings={() => setFpSettings(true)}
        />
        <ContextMenu items={menu}>
          <div
            className={isSplit ? 'chart-hosts split' : 'chart-hosts'}
            onContextMenu={capturePx}
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
          </div>
        </ContextMenu>
        {domTrader && <DomTrader instrumentId={s.instrumentId} lots={s.lots} />}
      </div>
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
          value="eth"
          onChange={() => {}}
          options={[
            { value: 'eth', label: 'ETH' },
            { value: 'rth', label: 'RTH' },
            { value: '24h', label: '24h' },
          ]}
        />
        <span className="muted">
          {s.template === 'liquidity-map'
            ? `Brightness 100 · Cut-off 98/20 · ${store.depth.length} columns`
            : `History ${Math.round((store.trades.length ? store.lastTs - store.trades[0]!.ts : 0) / 3_600_000)} h · ${store.trades.length.toLocaleString()} ticks`}
        </span>
        <div className="grow" />
        <button
          className="ht-chip ht-chip--ghost"
          aria-pressed={domTrader}
          onClick={() => setDomTrader((x) => !x)}
        >
          DOM Trader
        </button>
        <button
          className="ht-chip ht-chip--ghost"
          onClick={() => useWindows.getState().setTradingPanel(!useWindows.getState().tradingPanel)}
        >
          Trading Panel
        </button>
      </div>
      <FootprintSettingsDialog
        open={fpSettings}
        onOpenChange={setFpSettings}
        handle={handle}
        mode={s.footprintMode}
        onMode={(m) => set({ footprintMode: m })}
      />
    </div>
  );
}

function FootprintSettingsDialog({
  open,
  onOpenChange,
  handle,
  mode,
  onMode,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  handle: React.MutableRefObject<ChartHandle | null>;
  mode: string;
  onMode: (m: string) => void;
}) {
  const layer = () =>
    handle.current?.cores[0]?.layers.find((l) => l.id === 'footprint') as
      { settings: FootprintSettings } | undefined;
  const [, force] = useState(0);
  const st = layer()?.settings;
  const upd = (fn: (x: FootprintSettings) => void) => {
    const l = layer();
    if (!l) return;
    fn(l.settings);
    handle.current?.cores.forEach((c) => c.invalidate());
    force((x) => x + 1);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Footprint quick settings"
      description="Live preview. Full Chart settings (P34) adds colours, filters and presets."
      width={420}
    >
      {!st ? (
        <p className="muted">Open a footprint chart to edit these settings.</p>
      ) : (
        <div className="col gap12">
          <Field label="Footprint content">
            <Select
              value={mode}
              onChange={onMode}
              options={FOOTPRINT_MODES.map((m) => ({
                value: m.id,
                label: `${m.group} · ${m.label}`,
              }))}
            />
          </Field>
          <Field label="Ticks per row">
            <Select
              value={String(st.ticksPerRow)}
              onChange={(v) => upd((x) => (x.ticksPerRow = v === 'auto' ? 'auto' : Number(v)))}
              options={['auto', '1', '2', '4', '5', '10'].map((v) => ({ value: v, label: v }))}
            />
          </Field>
          <Field label="Imbalance ratio (%)" hint="Diagonal bid/ask comparison; default 300%">
            <NumberInput
              value={st.imbalance.ratio * 100}
              step={25}
              min={100}
              onChange={(v) => upd((x) => (x.imbalance.ratio = v / 100))}
            />
          </Field>
          <Field label="Stacked imbalance levels">
            <NumberInput
              value={st.imbalance.stacked}
              step={1}
              min={2}
              max={10}
              onChange={(v) => upd((x) => (x.imbalance.stacked = v))}
            />
          </Field>
          <Field label="Candle width to auto-transform (px)">
            <NumberInput
              value={st.autoCandleWidth}
              step={1}
              min={0}
              max={200}
              onChange={(v) => upd((x) => (x.autoCandleWidth = v))}
            />
          </Field>
          <Checkbox
            checked={st.imbalance.enabled}
            onChange={(v) => upd((x) => (x.imbalance.enabled = v))}
            label="Bid/Ask imbalance"
          />
          <Checkbox
            checked={st.showPoc}
            onChange={(v) => upd((x) => (x.showPoc = v))}
            label="POC box per bar"
          />
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
      )}
    </Dialog>
  );
}
