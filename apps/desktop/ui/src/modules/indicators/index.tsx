import type { ChartLayer, PointerHandler } from '@htflow/chart-engine';
import {
  DerivativesLog,
  ForeignRuntime,
  IndicatorRuntime,
  IndicatorScene,
  PaneSpacerLayer,
  alertTriggered,
  describeIndicatorAlert,
  formatValue,
  movePane,
  mtfOf,
  specInputs,
  tfClassOf,
  titleOf,
  type AlertSample,
  type AnyIndicator,
  type BarData,
  type EngineSpec,
  type Hotspot,
  type IndicatorConfig,
  type RuntimeLike,
  type SourceId,
  isPriceSource,
} from '@htflow/indicator-sdk';
import { CATALOG, indicatorById, poolable } from '@htflow/indicators';
import type { BarSpec, MarketStore } from '@htflow/market-data';
import { t } from '@htflow/i18n';
import { Chip, toast } from '@htflow/ui-kit';
import { createCotFeed } from '../../state/cotFeed';
import type { ChartWindowState } from '@htflow/workspace';
import { registerChartExtension, registerHeaderItem } from '../../charts/extensions';
import { registerCommands, registerPaletteProvider } from '../../shell/commands';
import { useWindows } from '../../state/windows';
import { hub } from '../../state/market';
import { instrumentById } from '../../state/instruments';
import { notify } from '../alerts/runtime';
import { useSettingsStore } from '../../state/settings';
import { chartSettingFor } from '../../charts/settings/state';
import { IndicatorsDialog } from './Dialog';
import { indicatorPaletteItems } from './palette';
import {
  EXT_ID,
  addIndicatorToChart,
  contexts,
  readExt,
  targetChart,
  useIndicatorDialog,
  writeExt,
} from './state';
import { indicatorPool } from './pool';
import { scriptSource } from './scripts';
import type { MenuEntry } from '@htflow/ui-kit';
import { canMovePane, indicatorsInPane, moveIndicator, type PaneMove } from './menuModel';
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

function dropOnPane(windowId: string, uid: string, target: Parameters<typeof movePane>[2]): void {
  const items = readExt(windowId).items;
  const next = movePane(items, uid, target);
  if (next !== items) writeExt(windowId, next);
}

/** Display unit of an output: price outputs computed from a non-price source are not prices. */
function isPriceOutput(def: AnyIndicator, rt: RuntimeLike, output: string): boolean {
  const inputs = rt.inputs as Record<string, unknown>;
  if (typeof inputs.unit === 'string') return inputs.unit === 'price';
  const src = inputs.source;
  return (
    def.outputs[output]?.unit === 'price' &&
    (typeof src !== 'string' || isPriceSource(src as SourceId))
  );
}

/** Indicator alerts that already fired (cooldown / once), shared per alert id. */
const firedAt = new Map<string, number>();

/**
 * Alerts tab (P13): after market updates, tests each enabled alert on the indicator's last bar
 * (or the last closed bar) and routes fires to the Alerts module (toast, sound, activity log).
 */
function watchAlerts(
  windowId: string,
  scene: IndicatorScene,
  data: BarData,
  store: MarketStore,
): () => void {
  const prev = new Map<string, AlertSample & { bar: number }>();
  return store.subscribe(() => {
    for (const it of scene.items) {
      const alerts = it.cfg.alerts.filter((a) => a.enabled);
      if (!alerts.length || !it.cfg.enabled) continue;
      it.rt.update(data);
      const n = it.rt.count;
      for (const a of alerts) {
        const i = a.when === 'close' ? n - 2 : n - 1;
        if (i < 0) continue;
        const key = `${it.cfg.uid}:${a.id}`;
        const price = isPriceOutput(it.def, it.rt, a.output);
        const tick = store.instrument.tickSize;
        const cur = {
          x: it.rt.valueAt(a.output, i),
          y: a.target === 'output' ? it.rt.valueAt(a.other, i) : price ? a.value / tick : a.value,
          bar: i,
        };
        const before = prev.get(key) ?? null;
        if (a.when === 'close' && before?.bar === i) continue;
        prev.set(key, cur);
        if (!alertTriggered(a.cond, before, cur)) continue;
        const now = Date.now();
        const was = firedAt.get(key);
        if (was !== undefined && now - was < 1500) continue;
        firedAt.set(key, now);
        const inst = store.instrument;
        const label = (o: string) => it.styles[o]?.label ?? it.def.outputs[o]?.label ?? o;
        const fmt = (v: number) =>
          price ? formatValue(v / tick, 'price', inst) : formatValue(v, 'value', inst);
        notify({
          title: `${inst.symbol} ${it.title}`,
          body: `${describeIndicatorAlert(a, label, fmt)} · ${label(a.output)} = ${formatValue(cur.x, price ? 'price' : 'value', inst)}`,
          instrumentId: inst.id,
          popup: a.toast,
          sound: a.sound,
          log: a.log,
        });
        if (a.once) {
          const items = readExt(windowId).items.map((c) =>
            c.uid === it.cfg.uid
              ? {
                  ...c,
                  alerts: c.alerts.map((x) => (x.id === a.id ? { ...x, enabled: false } : x)),
                }
              : c,
          );
          writeExt(windowId, items);
        }
      }
    }
  });
}

registerChartExtension({
  id: EXT_ID,
  attach(ctx) {
    if (!ctx.series()) return;
    contexts.set(ctx.windowId, ctx);
    const store = ctx.store;
    const derivatives = new DerivativesLog();
    const detachFeeds = derivatives.attach(store);
    const cotFeed = createCotFeed(store.instrument.symbol, () => ctx.core.invalidate());
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
      get cot() {
        return cotFeed.data();
      },
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
    const core = ctx.core;
    // Other symbols used as indicator data sources (retained while this chart lives).
    const foreign = new Map<string, { store: MarketStore; unsub: () => void }>();
    const foreignData = (id: string) => {
      let f = foreign.get(id);
      if (!f) {
        const store = hub.retain(id);
        f = { store, unsub: store.subscribe(() => core.invalidate()) };
        foreign.set(id, f);
      }
      const series = f.store.getSeries(ctx.state().timeframe as BarSpec);
      return (): BarData => ({
        bars: series.bars,
        version: series.version,
        tickSize: f.store.instrument.tickSize,
      });
    };
    const factory = (cfg: IndicatorConfig, def: AnyIndicator): RuntimeLike => {
      const mtf = cfg.tf !== 'chart' ? { tf: cfg.tf, mode: cfg.tfMode } : undefined;
      const spec: EngineSpec = {
        type: def.id,
        inputs: cfg.inputs,
        mtf,
        script: scriptSource(def.id),
      };
      const eff = mtf ? mtfOf(def) : def;
      const inputs = specInputs(spec);
      if (cfg.symbol && cfg.symbol !== store.instrument.id && instrumentById(cfg.symbol)) {
        const sym = instrumentById(cfg.symbol)!.symbol;
        return new ForeignRuntime(
          eff,
          inputs,
          foreignData(cfg.symbol),
          store.instrument.tickSize,
          sym,
        );
      }
      if (def.category === 'cot') cotFeed.ensure();
      const pool = poolable(def) ? indicatorPool() : null;
      if (pool) return pool.create(eff, spec, () => core.invalidate());
      return new IndicatorRuntime(eff, inputs);
    };
    const scene = new IndicatorScene(() => data, indicatorById, factory);
    scenes.set(ctx.windowId, scene);
    const others = ctx.cores.filter((c) => c !== core);
    const spacer = new PaneSpacerLayer(scene);
    let last: unknown = Symbol('none');
    const apply = () => {
      const show = chartSettingFor(ctx.windowId, 'other.indicatorValues') !== false;
      if (show !== scene.showValues) {
        scene.showValues = show;
        core.invalidate();
      }
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
    const unsubWin = useWindows.subscribe(apply);
    const unsubSet = useSettingsStore.subscribe(apply);
    const unsub = () => {
      unsubWin();
      unsubSet();
    };
    let pressed: { h: Hotspot; y: number } | null = null;
    const ph: PointerHandler = {
      onDown(_v, x, y) {
        const h = scene.hit(x, y);
        pressed = h ? { h, y } : null;
        return !!pressed;
      },
      onMove(_v, _x, y, _e, captured) {
        // Drag an indicator's legend title to another pane (P13).
        if (!captured || !pressed || pressed.h.action !== 'settings') return;
        if (!scene.drag && Math.abs(y - pressed.y) < 6) return;
        scene.drag = { uid: pressed.h.uid, y };
        core.invalidate();
      },
      onUp(_v, x, y) {
        const p = pressed;
        pressed = null;
        if (scene.drag) {
          const drag = scene.drag;
          scene.drag = null;
          core.invalidate();
          const t = scene.dropTarget(y);
          if (t) dropOnPane(ctx.windowId, drag.uid, t.target);
          return;
        }
        const h = scene.hit(x, y);
        if (p && h && h.uid === p.h.uid && h.action === p.h.action) act(ctx.windowId, h);
      },
      cursor: (_v, x, y) =>
        scene.drag
          ? 'grabbing'
          : scene.hit(x, y)?.action === 'settings'
            ? 'grab'
            : scene.hit(x, y)
              ? 'pointer'
              : null,
    };
    const unwatch = watchAlerts(ctx.windowId, scene, data, store);
    core.pointerHandlers.push(ph);
    return () => {
      unsub();
      unwatch();
      scene.dispose();
      for (const [id, f] of foreign) {
        f.unsub();
        hub.release(id);
      }
      detachFeeds();
      cotFeed.detach();
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

// Command Palette rows: choosing an indicator adds it to the active chart (as the dialog's "+" does).
registerPaletteProvider(() =>
  indicatorPaletteItems(CATALOG, (e) => {
    const id = targetChart();
    if (!id) toast('error', 'Open a chart first to add an indicator');
    else addIndicatorToChart(id, e);
  }),
);
