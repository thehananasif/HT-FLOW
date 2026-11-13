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
import type { MenuEntry } from '@htflow/ui-kit';
import { IndicatorsDialog } from './Dialog';
import { canMovePane, indicatorsInPane, moveIndicator, type PaneMove } from './menuModel';
import { EXT_ID, contexts, readExt, targetChart, useIndicatorDialog, writeExt } from './state';
import './styles.css';

const isOurs = (l: ChartLayer) => l.id.startsWith('ind');

/** Indicator scene per chart window (right-click hit testing on the legend). */
const scenes = new Map<string, IndicatorScene>();

/** Context items for indicators under the cursor (P26: settings / hide / remove / move pane). */
function indicatorItems(windowId: string, uids: string[]): MenuEntry[] {
  const items = readExt(windowId).items;
  const out: MenuEntry[] = [];
  for (const uid of uids) {
    const c = items.find((x) => x.uid === uid);
    const d = c ? indicatorById(c.type) : undefined;
    if (!c || !d) continue;
    const move = (to: PaneMove) => () =>
      writeExt(windowId, moveIndicator(readExt(windowId).items, uid, to));
    const entries: MenuEntry[] = [
      {
        id: `ind-settings-${uid}`,
        label: 'Indicator settings…',
        onSelect: () => useIndicatorDialog.getState().open(windowId, uid),
      },
      {
        id: `ind-hide-${uid}`,
        label: c.enabled ? 'Hide indicator' : 'Show indicator',
        onSelect: () => act(windowId, { uid, action: 'toggle', x: 0, y: 0, w: 0, h: 0 }),
      },
      {
        id: `ind-remove-${uid}`,
        label: 'Remove indicator',
        onSelect: () => act(windowId, { uid, action: 'remove', x: 0, y: 0, w: 0, h: 0 }),
      },
      {
        kind: 'submenu',
        id: `ind-move-${uid}`,
        label: 'Move to pane',
        items: [
          {
            id: `ind-mv-overlay-${uid}`,
            label: 'Price pane (overlay)',
            checked: c.pane === 'overlay',
            onSelect: move('overlay'),
          },
          {
            id: `ind-mv-new-${uid}`,
            label: 'New pane below',
            checked: c.pane === 'new',
            onSelect: move('new'),
          },
          {
            id: `ind-mv-up-${uid}`,
            label: 'Move pane up',
            disabled: !canMovePane(items, uid, 'up'),
            onSelect: move('up'),
          },
          {
            id: `ind-mv-down-${uid}`,
            label: 'Move pane down',
            disabled: !canMovePane(items, uid, 'down'),
            onSelect: move('down'),
          },
        ],
      },
    ];
    out.push({ kind: 'label', id: `ind-l-${uid}`, label: titleOf(d, c.inputs) }, ...entries);
  }
  return out.length ? [{ kind: 'separator', id: 'ind-ctx-s' }, ...out] : [];
}

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
    scenes.set(ctx.windowId, scene);
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
      if (scenes.get(ctx.windowId) === scene) scenes.delete(ctx.windowId);
      core.pointerHandlers = core.pointerHandlers.filter((p) => p !== ph);
      for (const c of ctx.cores) c.setLayers(c.layers.filter((l) => !isOurs(l)));
    };
  },
  menu(ctx, _px, at) {
    // Context-aware: an indicator legend row or an indicator sub-pane under the cursor.
    const uids: string[] = [];
    if (at && at.core === ctx.core) {
      const h = scenes.get(ctx.windowId)?.hit(at.x, at.y);
      if (h) uids.push(h.uid);
      else if (at.hit.layerId)
        uids.push(...indicatorsInPane(readExt(ctx.windowId).items, at.hit.layerId));
    }
    return [
      ...indicatorItems(ctx.windowId, uids),
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
