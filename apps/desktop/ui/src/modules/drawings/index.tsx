import './styles.css';
import {
  DrawingController,
  DrawingsLayer,
  History,
  makeProj,
  supportsAlert,
  TimeAxis,
  toolDef,
  TOOL_GROUPS,
  TOOLS,
  toolsIn,
  type Drawing,
} from '@htflow/drawings';
import { t } from '@htflow/i18n';
import { specKey } from '@htflow/market-data';
import type { ChartCore } from '@htflow/chart-engine';
import { type MenuEntry } from '@htflow/ui-kit';
import './alerts';
import { registerChartExtension, type ChartExtensionContext } from '../../charts/extensions';
import { commands, onCommandsChange, registerCommands, type Command } from '../../shell/commands';
import { registerModule } from '../registry';
import {
  activateTool,
  activeChartId,
  controllers,
  EXT_ID,
  loadPrefs,
  openObjectsList,
  mutateSelection,
  readDrawings,
  runToolCommand,
  saveDrawings,
  selectionOf,
  useDrawUi,
} from './store';
import { MagnifierLayer } from './lens';
import { menuGroupLabel, toolLabel, toolPendingLabel } from './toolText';
import { DrawingsOverlay, ObjectsList } from './ui';

/** One controller per built chart (rebuilt with the chart on template / timeframe change). */
function ensure(ctx: ChartExtensionContext) {
  const cur = controllers.get(ctx.windowId);
  if (cur && cur.ctx === ctx) return cur;
  const id = ctx.windowId;
  const ui = () => useDrawUi.getState();
  const invalidateAll = () => ctx.cores.forEach((c) => c.invalidate());
  const mainAxis = new TimeAxis(
    () => ctx.core.source.count(),
    (i) => ctx.core.source.timeAt(i),
    () => {
      const s = ctx.state();
      if (s.template === 'liquidity-map') return Math.max(250, s.heatColumnMs);
      return s.timeframe.kind === 'time' ? s.timeframe.ms : undefined;
    },
  );
  const history = new History();
  /** Controller for one chart pane; extra panes have no bars (price-only drawings). */
  const make = (core: ChartCore, axis: TimeAxis, withBars: boolean) =>
    new DrawingController(
      {
        items: () => readDrawings(id),
        save: (next) => saveDrawings(id, next),
        tool: () => ui().tool[id] ?? null,
        setTool: (t) => ui().setTool(id, t),
        keepDrawing: () => ui().prefs.keep,
        magnet: () => ({
          magnet: ui().prefs.magnet,
          px: ui().prefs.magnetPx,
          snapTicks: ui().prefs.snapTicks,
        }),
        proj: (v) => {
          const series = withBars ? ctx.series() : null;
          return makeProj(v, axis, series ? series.bars : null, series ? series.version : 0);
        },
        selected: () => ui().selected[id] ?? null,
        select: (sel) => ui().select(id, sel),
        selectedIds: () => selectionOf(id),
        selectMany: (ids) => ui().selectMany(id, ids),
        tfKey: () => specKey(ctx.state().timeframe),
        invalidate: invalidateAll,
        onCreated: (d) => {
          if (toolDef(d.type)?.group === 'text' || d.type === 'emoji')
            ui().edit({ windowId: id, id: d.id });
        },
        onEdit: (drawingId) => ui().edit({ windowId: id, id: drawingId }),
      },
      history,
    );
  const ctrl = make(ctx.core, mainAxis, true);
  // Order Flow (Dark) has a second pane (tape chart): drawings work there too, on its own x axis.
  const extra = ctx.cores
    .filter((c) => c !== ctx.core)
    .map((core) => ({
      core,
      ctrl: make(
        core,
        new TimeAxis(
          () => core.source.count(),
          (i) => core.source.timeAt(i),
        ),
        false,
      ),
    }));
  const entry = { ctrl, ctx, extra };
  controllers.set(id, entry);
  return entry;
}

function drawingMenu(ctx: ChartExtensionContext, d: Drawing): MenuEntry[] {
  const { ctrl } = ensure(ctx);
  const name = toolDef(d.type) ? toolLabel(d.type) : t('drawings.drawing');
  const sel = selectionOf(ctx.windowId);
  const inGroup = sel.length > 1 && sel.includes(d.id);
  return [
    { kind: 'separator', id: 'dr-s0' },
    { kind: 'label', id: 'dr-l', label: name },
    {
      id: 'dr-edit',
      label: t('drawings.editDrawing'),
      onSelect: () => useDrawUi.getState().edit({ windowId: ctx.windowId, id: d.id }),
    },
    { id: 'dr-clone', label: t('drawings.cloneDrawing'), onSelect: () => ctrl.clone(d.id) },
    ...(supportsAlert(d.type)
      ? [
          {
            id: 'dr-alert',
            label: t('drawings.alertOnCross'),
            checked: d.alert,
            onSelect: () => ctrl.update(d.id, (x) => ({ ...x, alert: !x.alert })),
          },
        ]
      : []),
    {
      id: 'dr-lock',
      label: d.locked ? t('drawings.unlockDrawing') : t('drawings.lockDrawing'),
      onSelect: () => ctrl.update(d.id, (x) => ({ ...x, locked: !x.locked })),
    },
    {
      id: 'dr-hide',
      label: t('drawings.hideDrawing'),
      onSelect: () => ctrl.update(d.id, (x) => ({ ...x, hidden: true })),
    },
    { id: 'dr-front', label: t('drawings.bringFront'), onSelect: () => ctrl.bringToFront(d.id) },
    { id: 'dr-back', label: t('drawings.sendBack'), onSelect: () => ctrl.sendToBack(d.id) },
    {
      id: 'dr-del',
      label: inGroup ? t('drawings.deleteSelected') : t('drawings.deleteDrawing'),
      shortcut: 'Del',
      onSelect: () => void (inGroup ? ctrl.removeSelected() : ctrl.remove(d.id)),
    },
  ];
}

const layerFor = (c: DrawingController) =>
  new DrawingsLayer({
    list: () => c.list(),
    selected: () => c.host.selected(),
    selectedIds: () => c.selection(),
    box: () => c.boxRect(),
    proj: (v) => c.host.proj(v),
  });

const lensFor = (ctx: ChartExtensionContext) =>
  new MagnifierLayer(() => {
    const u = useDrawUi.getState();
    return { on: !!u.lens[ctx.windowId], zoom: u.prefs.lensZoom, size: u.prefs.lensSize };
  });

registerChartExtension({
  id: EXT_ID,
  layers(ctx) {
    const { ctrl } = ensure(ctx);
    return [layerFor(ctrl), lensFor(ctx)];
  },
  attach(ctx) {
    loadPrefs();
    const entry = ensure(ctx);
    ctx.core.pointerHandlers.push(entry.ctrl);
    const restore: (() => void)[] = [];
    for (const { core, ctrl } of entry.extra) {
      core.pointerHandlers.push(ctrl);
      const prev = core.layers;
      const layers = prev.slice();
      const li = layers.findIndex((l) => l.id === 'legend');
      layers.splice(li < 0 ? layers.length : li, 0, layerFor(ctrl), lensFor(ctx));
      core.setLayers(layers);
      restore.push(() => {
        const k = core.pointerHandlers.indexOf(ctrl);
        if (k >= 0) core.pointerHandlers.splice(k, 1);
      });
    }
    return () => {
      const i = ctx.core.pointerHandlers.indexOf(entry.ctrl);
      if (i >= 0) ctx.core.pointerHandlers.splice(i, 1);
      restore.forEach((r) => r());
      if (controllers.get(ctx.windowId) === entry) controllers.delete(ctx.windowId);
    };
  },
  menu(ctx) {
    const { ctrl } = ensure(ctx);
    const ui = useDrawUi.getState();
    const v = ctx.core.view;
    const hit = v?.crosshair ? ctrl.hitAt(v, v.crosshair.x, v.crosshair.y) : null;
    // menu() runs while the chart renders: it must not change the selection (hover would select).
    const active = ui.tool[ctx.windowId] ?? null;
    const p = ui.prefs;
    return [
      ...(hit ? drawingMenu(ctx, hit.d) : []),
      { kind: 'separator', id: 'dr-s1' },
      {
        kind: 'submenu',
        id: 'dr-objects',
        label: t('drawings.drawingObjects'),
        items: [
          ...TOOL_GROUPS.map((g): MenuEntry => ({
            kind: 'submenu',
            id: `dr-g-${g.id}`,
            label: menuGroupLabel(g.id, g.label),
            items: toolsIn(g.id).map((t) => ({
              id: `dr-t-${t.id}`,
              label: t.ready ? toolLabel(t.id) : toolPendingLabel(t.id),
              shortcut: t.shortcut,
              disabled: !t.ready,
              checked: active === t.id,
              onSelect: () => activateTool(t.id, ctx.windowId),
            })),
          })),
          {
            id: 'dr-magnifier',
            label: t('drawings.magnifier'),
            shortcut: 'M',
            checked: !!ui.lens[ctx.windowId],
            onSelect: () => runToolCommand('magnifier', ctx.windowId),
          },
          {
            id: 'dr-remove-ind',
            label: t('drawings.removeIndicators'),
            onSelect: () => runToolCommand('remove-indicators', ctx.windowId),
          },
          { kind: 'separator', id: 'dr-s2' },
          { id: 'dr-list', label: t('drawings.objectsList'), onSelect: openObjectsList },
          {
            kind: 'submenu',
            id: 'dr-actions',
            label: t('drawings.actions'),
            items: [
              {
                id: 'dr-a-del',
                label: t('drawings.deleteSelectedAction'),
                shortcut: 'Del',
                onSelect: () => void ctrl.removeSelected(),
              },
              {
                id: 'dr-a-all',
                label: t('drawings.deleteAllDrawings'),
                onSelect: () => ctrl.removeAll(),
              },
              {
                id: 'dr-a-undo',
                label: t('drawings.undo'),
                shortcut: 'Ctrl+Z',
                onSelect: () => void ctrl.undo(),
              },
              {
                id: 'dr-a-redo',
                label: t('drawings.redo'),
                shortcut: 'Ctrl+Y',
                onSelect: () => void ctrl.redo(),
              },
            ],
          },
          { kind: 'separator', id: 'dr-s3' },
          {
            kind: 'submenu',
            id: 'dr-magnet',
            label: t('drawings.magnetMenu', { v: p.magnet ? p.magnetPx : t('drawings.offLower') }),
            items: [
              {
                id: 'dr-m-off',
                label: t('drawings.off'),
                checked: !p.magnet,
                onSelect: () => ui.setPrefs({ magnet: false }),
              },
              ...[4, 8, 12, 16, 24].map((n) => ({
                id: `dr-m-${n}`,
                label: t('drawings.px', { n }),
                checked: p.magnet && p.magnetPx === n,
                onSelect: () => ui.setPrefs({ magnet: true, magnetPx: n }),
              })),
              { kind: 'separator', id: 'dr-m-sep' },
              {
                kind: 'slider',
                id: 'dr-m-slider',
                label: t('drawings.sensitivity'),
                value: p.magnetPx,
                min: 2,
                max: 40,
                step: 1,
                format: (v: number) => t('drawings.px', { n: v }),
                onChange: (v: number) => ui.setPrefs({ magnet: true, magnetPx: v }),
              },
            ],
          },
          {
            id: 'dr-snap',
            label: t('drawings.snapToTicks'),
            checked: p.snapTicks,
            onSelect: () => ui.setPrefs({ snapTicks: !p.snapTicks }),
          },
          {
            id: 'dr-keep',
            label: t('drawings.keepDrawingMenu'),
            checked: p.keep,
            onSelect: () => ui.setPrefs({ keep: !p.keep }),
          },
          {
            id: 'dr-bar',
            label: t('drawings.objectsToolbar'),
            checked: p.toolbar,
            onSelect: () => ui.setPrefs({ toolbar: !p.toolbar }),
          },
          {
            id: 'dr-prefs',
            label: t('drawings.prefsMenu'),
            onSelect: () => ui.openPrefs(true),
          },
        ],
      },
    ];
  },
  Overlay: DrawingsOverlay,
});

registerModule({ id: 'drawing-objects', label: t('drawings.objectsList'), view: ObjectsList });

const ctrlOf = () => {
  const id = activeChartId();
  return id ? (controllers.get(id)?.ctrl ?? null) : null;
};

/** True while a text field has focus: Ctrl+Z / Ctrl+A / Del belong to the field, not the chart. */
const typing = (): boolean => {
  const t = document.activeElement as HTMLElement | null;
  return (
    !!t &&
    (t.tagName === 'INPUT' ||
      t.tagName === 'TEXTAREA' ||
      t.tagName === 'SELECT' ||
      t.isContentEditable ||
      !!t.closest?.('[role="dialog"]'))
  );
};

const cmds: Command[] = [
  ...TOOLS.filter((tool) => tool.ready).map((tool): Command => ({
    id: `draw.${tool.id}`,
    label: tool.command
      ? t('drawings.cmdDrawing', { label: toolLabel(tool.id) })
      : t('drawings.cmdDraw', { label: toolLabel(tool.id) }),
    group: 'Drawing',
    shortcut: tool.shortcut,
    scope: tool.id === 'magnifier' ? 'chart' : undefined,
    keywords: `drawing ${tool.group}`,
    run: () => activateTool(tool.id),
  })),
  {
    id: 'draw.objects',
    label: t('drawings.cmdObjectsList'),
    group: 'Drawing',
    run: openObjectsList,
  },
  {
    id: 'draw.keep',
    label: t('drawings.cmdKeep'),
    group: 'Drawing',
    run: () => useDrawUi.getState().setPrefs({ keep: !useDrawUi.getState().prefs.keep }),
  },
  {
    id: 'draw.magnet',
    label: t('drawings.cmdToggleMagnet'),
    group: 'Drawing',
    run: () => useDrawUi.getState().setPrefs({ magnet: !useDrawUi.getState().prefs.magnet }),
  },
  {
    id: 'draw.snap',
    label: t('drawings.cmdToggleSnap'),
    group: 'Drawing',
    run: () => useDrawUi.getState().setPrefs({ snapTicks: !useDrawUi.getState().prefs.snapTicks }),
  },
  {
    id: 'draw.prefs',
    label: t('drawings.cmdPrefs'),
    group: 'Drawing',
    keywords: 'magnet slider lens zoom',
    run: () => useDrawUi.getState().openPrefs(true),
  },
  {
    id: 'draw.alert',
    label: t('drawings.cmdToggleAlert'),
    group: 'Drawing',
    keywords: 'alert cross enter exit line channel rectangle',
    run: () => {
      const id = activeChartId();
      if (id) mutateSelection(id, (d) => (supportsAlert(d.type) ? { ...d, alert: !d.alert } : d));
    },
  },
  {
    id: 'draw.lock',
    label: t('drawings.cmdLock'),
    group: 'Drawing',
    run: () => {
      const id = activeChartId();
      if (id) mutateSelection(id, (d) => ({ ...d, locked: !d.locked }));
    },
  },
  {
    id: 'draw.select-all',
    label: t('drawings.cmdSelectAll'),
    group: 'Drawing',
    shortcut: 'Ctrl+A',
    scope: 'chart',
    run: () => {
      const id = activeChartId();
      if (!id || typing()) return;
      useDrawUi.getState().selectMany(
        id,
        readDrawings(id)
          .filter((d) => !d.hidden)
          .map((d) => d.id),
      );
    },
  },
  {
    id: 'draw.delete',
    label: t('drawings.cmdDeleteSelected'),
    group: 'Drawing',
    shortcut: 'Del',
    scope: 'chart',
    run: () => {
      if (!typing()) void ctrlOf()?.removeSelected();
    },
  },
  {
    id: 'draw.delete-all',
    label: t('drawings.cmdDeleteAll'),
    group: 'Drawing',
    run: () => ctrlOf()?.removeAll(),
  },
  {
    id: 'draw.undo',
    label: t('drawings.cmdUndo'),
    group: 'Drawing',
    shortcut: 'Ctrl+Z',
    scope: 'chart',
    run: () => {
      if (!typing()) void ctrlOf()?.undo();
    },
  },
  {
    id: 'draw.redo',
    label: t('drawings.cmdRedo'),
    group: 'Drawing',
    shortcut: 'Ctrl+Y',
    scope: 'chart',
    run: () => {
      if (!typing()) void ctrlOf()?.redo();
    },
  },
];
// Registered after the dashboard's own commands so drawing tools never outrank core commands
// (layouts, instruments) for the same search term in the Command Palette.
let busy = false;
let unregister: (() => void) | null = null;
const registerOnce = () => {
  if (busy) return;
  const ids = commands().map((c) => c.id);
  if (!ids.includes('palette')) return;
  const firstMine = ids.findIndex((id) => id.startsWith('draw.'));
  let lastOther = -1;
  ids.forEach((id, i) => {
    if (!id.startsWith('draw.')) lastOther = i;
  });
  if (unregister && firstMine > lastOther) return;
  busy = true;
  unregister?.();
  unregister = registerCommands(cmds);
  busy = false;
};
onCommandsChange(registerOnce);
registerOnce();

// Esc cancels the current tool / draft when the chart canvas is not focused (never while typing).
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || typing()) return;
  const ctrl = ctrlOf();
  if (ctrl && (ctrl.creating || ctrl.host.tool()) && ctrl.onKey(e)) e.preventDefault();
});
