import './styles.css';
import {
  DrawingController,
  DrawingsLayer,
  makeProj,
  TimeAxis,
  toolDef,
  TOOL_GROUPS,
  TOOLS,
  toolsIn,
  type Drawing,
} from '@htflow/drawings';
import { specKey } from '@htflow/market-data';
import { toast, type MenuEntry } from '@htflow/ui-kit';
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
  readDrawings,
  saveDrawings,
  useDrawUi,
} from './store';
import { DrawingsOverlay, ObjectsList } from './ui';

/** One controller per built chart (rebuilt with the chart on template / timeframe change). */
function ensure(ctx: ChartExtensionContext) {
  const cur = controllers.get(ctx.windowId);
  if (cur && cur.ctx === ctx) return cur;
  const id = ctx.windowId;
  const ui = () => useDrawUi.getState();
  const axis = new TimeAxis(
    () => ctx.core.source.count(),
    (i) => ctx.core.source.timeAt(i),
    () => {
      const s = ctx.state();
      if (s.template === 'liquidity-map') return Math.max(250, s.heatColumnMs);
      return s.timeframe.kind === 'time' ? s.timeframe.ms : undefined;
    },
  );
  const ctrl = new DrawingController({
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
      const series = ctx.series();
      return makeProj(v, axis, series ? series.bars : null, series ? series.version : 0);
    },
    selected: () => ui().selected[id] ?? null,
    select: (sel) => ui().select(id, sel),
    tfKey: () => specKey(ctx.state().timeframe),
    invalidate: () => ctx.core.invalidate(),
    onCreated: (d) => {
      if (toolDef(d.type)?.group === 'text') ui().edit({ windowId: id, id: d.id });
    },
    onEdit: (drawingId) => ui().edit({ windowId: id, id: drawingId }),
  });
  const entry = { ctrl, ctx };
  controllers.set(id, entry);
  return entry;
}

/** Toast once when the last price crosses a line that has "alert" on. */
function watchAlerts(ctx: ChartExtensionContext): () => void {
  let prev: number | null = null;
  const fired = new Set<string>();
  return ctx.store.subscribe(() => {
    const px = ctx.store.lastTrade?.px;
    if (px === undefined) return;
    if (prev !== null && prev !== px) {
      for (const d of readDrawings(ctx.windowId)) {
        if (!d.alert || fired.has(d.id) || !['horizontal-line', 'horizontal-ray'].includes(d.type))
          continue;
        const lvl = d.anchors[0]!.px;
        if ((prev < lvl && px >= lvl) || (prev > lvl && px <= lvl)) {
          fired.add(d.id);
          toast('warning', `${ctx.store.instrument.symbol} crossed ${toolDef(d.type)?.label}`);
        }
      }
    }
    prev = px;
  });
}

function drawingMenu(ctx: ChartExtensionContext, d: Drawing): MenuEntry[] {
  const { ctrl } = ensure(ctx);
  const name = toolDef(d.type)?.label ?? 'Drawing';
  return [
    { kind: 'separator', id: 'dr-s0' },
    { kind: 'label', id: 'dr-l', label: name },
    {
      id: 'dr-edit',
      label: 'Edit drawing…',
      onSelect: () => useDrawUi.getState().edit({ windowId: ctx.windowId, id: d.id }),
    },
    { id: 'dr-clone', label: 'Clone drawing', onSelect: () => ctrl.clone(d.id) },
    {
      id: 'dr-lock',
      label: d.locked ? 'Unlock drawing' : 'Lock drawing',
      onSelect: () => ctrl.update(d.id, (x) => ({ ...x, locked: !x.locked })),
    },
    {
      id: 'dr-hide',
      label: 'Hide drawing',
      onSelect: () => ctrl.update(d.id, (x) => ({ ...x, hidden: true })),
    },
    { id: 'dr-front', label: 'Bring to front', onSelect: () => ctrl.bringToFront(d.id) },
    { id: 'dr-back', label: 'Send to back', onSelect: () => ctrl.sendToBack(d.id) },
    { id: 'dr-del', label: 'Delete drawing', shortcut: 'Del', onSelect: () => ctrl.remove(d.id) },
  ];
}

registerChartExtension({
  id: EXT_ID,
  layers(ctx) {
    const { ctrl } = ensure(ctx);
    return [
      new DrawingsLayer({
        list: () => ctrl.list(),
        selected: () => ctrl.host.selected(),
        proj: (v) => ctrl.host.proj(v),
      }),
    ];
  },
  attach(ctx) {
    loadPrefs();
    const entry = ensure(ctx);
    ctx.core.pointerHandlers.push(entry.ctrl);
    const unAlerts = watchAlerts(ctx);
    return () => {
      const i = ctx.core.pointerHandlers.indexOf(entry.ctrl);
      if (i >= 0) ctx.core.pointerHandlers.splice(i, 1);
      unAlerts();
      if (controllers.get(ctx.windowId) === entry) controllers.delete(ctx.windowId);
    };
  },
  menu(ctx) {
    const { ctrl } = ensure(ctx);
    const ui = useDrawUi.getState();
    const v = ctx.core.view;
    const hit = v?.crosshair ? ctrl.hitAt(v, v.crosshair.x, v.crosshair.y) : null;
    if (hit) ui.select(ctx.windowId, hit.d.id);
    const active = ui.tool[ctx.windowId] ?? null;
    const p = ui.prefs;
    return [
      ...(hit ? drawingMenu(ctx, hit.d) : []),
      { kind: 'separator', id: 'dr-s1' },
      {
        kind: 'submenu',
        id: 'dr-objects',
        label: 'Drawing objects',
        items: [
          ...TOOL_GROUPS.map((g): MenuEntry => ({
            kind: 'submenu',
            id: `dr-g-${g.id}`,
            label: g.label,
            items: toolsIn(g.id).map((t) => ({
              id: `dr-t-${t.id}`,
              label: t.ready ? t.label : `${t.label} (pending)`,
              shortcut: t.shortcut,
              disabled: !t.ready,
              checked: active === t.id,
              onSelect: () => activateTool(t.id, ctx.windowId),
            })),
          })),
          { id: 'dr-magnifier', label: 'Magnifier (pending)', shortcut: 'M', disabled: true },
          { kind: 'separator', id: 'dr-s2' },
          { id: 'dr-list', label: 'Objects List', onSelect: openObjectsList },
          {
            kind: 'submenu',
            id: 'dr-actions',
            label: 'Actions',
            items: [
              {
                id: 'dr-a-del',
                label: 'Delete selected',
                shortcut: 'Del',
                onSelect: () => void ctrl.removeSelected(),
              },
              { id: 'dr-a-all', label: 'Delete all drawings', onSelect: () => ctrl.removeAll() },
              {
                id: 'dr-a-undo',
                label: 'Undo',
                shortcut: 'Ctrl+Z',
                onSelect: () => void ctrl.undo(),
              },
              {
                id: 'dr-a-redo',
                label: 'Redo',
                shortcut: 'Ctrl+Y',
                onSelect: () => void ctrl.redo(),
              },
            ],
          },
          { kind: 'separator', id: 'dr-s3' },
          {
            kind: 'submenu',
            id: 'dr-magnet',
            label: `Magnet sensitivity, px (${p.magnet ? p.magnetPx : 'off'})`,
            items: [
              {
                id: 'dr-m-off',
                label: 'Off',
                checked: !p.magnet,
                onSelect: () => ui.setPrefs({ magnet: false }),
              },
              ...[4, 8, 12, 16, 24].map((n) => ({
                id: `dr-m-${n}`,
                label: `${n} px`,
                checked: p.magnet && p.magnetPx === n,
                onSelect: () => ui.setPrefs({ magnet: true, magnetPx: n }),
              })),
            ],
          },
          {
            id: 'dr-snap',
            label: 'Snap to ticks',
            checked: p.snapTicks,
            onSelect: () => ui.setPrefs({ snapTicks: !p.snapTicks }),
          },
          {
            id: 'dr-keep',
            label: 'Keep Drawing',
            checked: p.keep,
            onSelect: () => ui.setPrefs({ keep: !p.keep }),
          },
          {
            id: 'dr-bar',
            label: 'Drawing objects toolbar',
            checked: p.toolbar,
            onSelect: () => ui.setPrefs({ toolbar: !p.toolbar }),
          },
        ],
      },
    ];
  },
  Overlay: DrawingsOverlay,
});

registerModule({ id: 'drawing-objects', label: 'Objects List', view: ObjectsList });

const ctrlOf = () => {
  const id = activeChartId();
  return id ? (controllers.get(id)?.ctrl ?? null) : null;
};

const cmds: Command[] = [
  ...TOOLS.filter((t) => t.ready).map((t): Command => ({
    id: `draw.${t.id}`,
    label: `Draw: ${t.label}`,
    group: 'Drawing',
    shortcut: t.shortcut,
    keywords: `drawing ${t.group}`,
    run: () => activateTool(t.id),
  })),
  { id: 'draw.objects', label: 'Drawing: Objects List', group: 'Drawing', run: openObjectsList },
  {
    id: 'draw.keep',
    label: 'Drawing: Keep Drawing (stay in tool)',
    group: 'Drawing',
    run: () => useDrawUi.getState().setPrefs({ keep: !useDrawUi.getState().prefs.keep }),
  },
  {
    id: 'draw.delete',
    label: 'Drawing: Delete selected',
    group: 'Drawing',
    shortcut: 'Del',
    run: () => void ctrlOf()?.removeSelected(),
  },
  {
    id: 'draw.delete-all',
    label: 'Drawing: Delete all drawings',
    group: 'Drawing',
    run: () => ctrlOf()?.removeAll(),
  },
  {
    id: 'draw.undo',
    label: 'Drawing: Undo (Ctrl+Z on the chart)',
    group: 'Drawing',
    run: () => void ctrlOf()?.undo(),
  },
  {
    id: 'draw.redo',
    label: 'Drawing: Redo (Ctrl+Y on the chart)',
    group: 'Drawing',
    run: () => void ctrlOf()?.redo(),
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

// Esc / Ctrl+Z / Ctrl+Y when the chart canvas is not focused (never while typing in a field).
window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement | null;
  if (
    t &&
    (t.tagName === 'INPUT' ||
      t.tagName === 'TEXTAREA' ||
      t.tagName === 'SELECT' ||
      t.isContentEditable)
  )
    return;
  if (t?.closest?.('[role="dialog"]')) return;
  const ctrl = ctrlOf();
  if (!ctrl) return;
  const k = e.key.toLowerCase();
  const isUndo = (e.ctrlKey || e.metaKey) && (k === 'z' || k === 'y');
  const isEsc = e.key === 'Escape' && (ctrl.creating || ctrl.host.tool());
  if ((isUndo || isEsc) && ctrl.onKey(e)) e.preventDefault();
});
