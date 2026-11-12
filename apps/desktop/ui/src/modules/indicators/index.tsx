import type { ChartLayer, PointerHandler } from '@htflow/chart-engine';
import {
  DerivativesLog,
  IndicatorScene,
  PaneSpacerLayer,
  tfClassOf,
  titleOf,
  type BarData,
  type Hotspot,
} from '@htflow/indicator-sdk';
import { indicatorById } from '@htflow/indicators';
import { t } from '@htflow/i18n';
import { Chip } from '@htflow/ui-kit';
import type { ChartWindowState } from '@htflow/workspace';
import { registerChartExtension, registerHeaderItem } from '../../charts/extensions';
import { registerCommands } from '../../shell/commands';
import { useWindows } from '../../state/windows';
import { IndicatorsDialog } from './Dialog';
import { EXT_ID, contexts, readExt, targetChart, useIndicatorDialog, writeExt } from './state';
import './styles.css';

const isOurs = (l: ChartLayer) => l.id.startsWith('ind');

function act(windowId: string, h: Hotspot): void {
  const items = readExt(windowId).items;
  if (h.action === 'settings') useIndicatorDialog.getState().open(windowId, h.uid);
  else if (h.action === 'toggle')
    writeExt(
      windowId,
      items.map((c) => (c.uid === h.uid ? { ...c, enabled: !c.enabled } : c)),
    );
  else
    writeExt(
      windowId,
      items.filter((c) => c.uid !== h.uid),
    );
}

registerChartExtension({
  id: EXT_ID,
  attach(ctx) {
    if (!ctx.series()) return;
    contexts.set(ctx.windowId, ctx);
    const store = ctx.store;
    const derivatives = new DerivativesLog();
    const detachFeeds = derivatives.attach(store);
    const data: BarData = {
      get bars() {
        return ctx.series()?.bars ?? [];
      },
      get version() {
        return ctx.series()?.version ?? 0;
      },
      tickSize: store.instrument.tickSize,
      tradesBetween: (a, b) => store.tradesBetween(a, b),
      derivatives,
      depth: {
        get version() {
          const d = store.depth;
          return d.length ? d[d.length - 1]!.t % 1e6 : 0;
        },
        get columns() {
          return store.depth;
        },
      },
    };
    const scene = new IndicatorScene(() => data, indicatorById);
    const core = ctx.core;
    const others = ctx.cores.filter((c) => c !== core);
    const spacer = new PaneSpacerLayer(scene);
    let last: unknown = Symbol('none');
    const apply = () => {
      const w = useWindows.getState().windows[ctx.windowId];
      const raw = w?.kind === 'chart' ? w.ext?.[EXT_ID] : undefined;
      if (raw === last) return;
      last = raw;
      scene.sync(readExt(ctx.windowId).items, tfClassOf(ctx.state().timeframe));
      const { below, above } = scene.layers();
      const layers = core.layers.filter((l) => !isOurs(l));
      const ci = layers.findIndex((l) => l.id === 'candles');
      layers.splice(ci < 0 ? 0 : ci, 0, ...below);
      const li = layers.findIndex((l) => l.id === 'legend');
      layers.splice(li < 0 ? layers.length : li, 0, ...above);
      core.setLayers(layers);
      for (const c of others) c.setLayers([...c.layers.filter((l) => !isOurs(l)), spacer]);
    };
    apply();
    const unsub = useWindows.subscribe(apply);
    let pressed: Hotspot | null = null;
    const ph: PointerHandler = {
      onDown(_v, x, y) {
        pressed = scene.hit(x, y);
        return !!pressed;
      },
      onUp(_v, x, y) {
        const h = scene.hit(x, y);
        if (pressed && h && h.uid === pressed.uid && h.action === pressed.action)
          act(ctx.windowId, h);
        pressed = null;
      },
      cursor: (_v, x, y) => (scene.hit(x, y) ? 'pointer' : null),
    };
    core.pointerHandlers.push(ph);
    return () => {
      unsub();
      detachFeeds();
      if (contexts.get(ctx.windowId) === ctx) contexts.delete(ctx.windowId);
      core.pointerHandlers = core.pointerHandlers.filter((p) => p !== ph);
      for (const c of ctx.cores) c.setLayers(c.layers.filter((l) => !isOurs(l)));
    };
  },
  menu(ctx) {
    return [
      {
        id: 'indicators',
        label: t('indicators.command'),
        shortcut: 'Ctrl+I',
        onSelect: () => useIndicatorDialog.getState().open(ctx.windowId),
      },
    ];
  },
  Overlay: function IndicatorsOverlay({ windowId, state }) {
    const open = useIndicatorDialog((s) => s.windowId === windowId);
    const items = readExt(windowId).items;
    return (
      <>
        {/* Accessible mirror of the canvas legend (screen readers, tests). */}
        <ul className="ind-sr" data-testid="indicator-legend" aria-label="Indicators on chart">
          {items.map((c) => {
            const d = indicatorById(c.type);
            return d ? (
              <li key={c.uid} data-enabled={c.enabled}>
                {titleOf(d, c.inputs)}
              </li>
            ) : null;
          })}
        </ul>
        {open && <IndicatorsDialog windowId={windowId} state={state} />}
      </>
    );
  },
});

function HeaderButton({ windowId, state }: { windowId: string; state: ChartWindowState }) {
  const raw = state.ext?.[EXT_ID] as { items?: unknown[] } | undefined;
  const n = Array.isArray(raw?.items) ? raw.items.length : 0;
  return (
    <Chip
      variant="ghost"
      data-testid="indicators-button"
      title={t('indicators.command')}
      onClick={() => useIndicatorDialog.getState().open(windowId)}
    >
      {t('indicators.button')}
      {n > 0 ? ` (${n})` : ''}
    </Chip>
  );
}

registerHeaderItem({ id: EXT_ID, order: 10, Component: HeaderButton });

registerCommands([
  {
    id: 'chart.indicators',
    label: t('indicators.command'),
    group: 'Chart',
    shortcut: 'Ctrl+I',
    keywords: 'indicator study overlay rsi ema vwap delta',
    run: () => {
      const id = targetChart();
      if (id) useIndicatorDialog.getState().open(id);
    },
  },
]);
