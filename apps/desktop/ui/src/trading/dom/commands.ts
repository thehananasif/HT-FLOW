import {
  BUILTIN_TEMPLATES,
  COLUMN_DEFS,
  serializeTemplates,
  toggleColumn,
  type DomTemplate,
} from '@htflow/dom';
import { registerCommands, runCommand, type Command } from '../../shell/commands';
import { useWindows } from '../../state/windows';
import { domActions } from './actions';
import { activeDom, domControllers, setWindowTemplate, smartDomExt } from './controllers';
import { domStore } from './store';
import { openDesigner } from './TemplateDesigner';

/** Runs `fn` on the active DOM window (or the first open DOM). */
function withDom(fn: (id: string, t: DomTemplate, instrumentId: string, lots: number) => void) {
  return () => {
    const d = activeDom();
    if (!d) return;
    fn(d.id, domStore.get(smartDomExt(d.s).template), d.s.instrumentId, d.s.lots);
  };
}

/** Opens a new Smart DOM (ribbon command) and applies a template to it. */
export function openDomWithTemplate(templateId: string): void {
  const before = new Set(Object.keys(useWindows.getState().windows));
  runCommand('open.smart-dom');
  const apply = () => {
    const ws = useWindows.getState().windows;
    const id = Object.keys(ws).find((k) => !before.has(k) && ws[k]!.kind === 'dom');
    if (id) setWindowTemplate(id, templateId);
    return !!id;
  };
  if (!apply()) setTimeout(apply, 0);
}

const label = (id: string) =>
  id === 'bidChg'
    ? 'Limit Δ (bid)'
    : id === 'askChg'
      ? 'Limit Δ (ask)'
      : (COLUMN_DEFS.find((c) => c.id === id)?.label ?? id);

const cmds: Command[] = [
  ...BUILTIN_TEMPLATES.map((t) => ({
    id: `dom.template.${t.id}`,
    label: `Smart DOM: use template ${t.name}`,
    group: 'Trading' as const,
    keywords: 'dom ladder template',
    run: () => {
      const d = activeDom();
      if (d) setWindowTemplate(d.id, t.id);
      else openDomWithTemplate(t.id);
    },
  })),
  ...BUILTIN_TEMPLATES.map((t) => ({
    id: `dom.open.${t.id}`,
    label: `Open Smart DOM — ${t.name}`,
    group: 'Analysis' as const,
    keywords: 'dom ladder new window',
    run: () => openDomWithTemplate(t.id),
  })),
  {
    id: 'dom.designer',
    label: 'Smart DOM: template designer…',
    group: 'Trading',
    keywords: 'dom template edit columns colours',
    run: withDom((id, t) => openDesigner({ windowId: id, templateId: t.id })),
  },
  {
    id: 'dom.new-template',
    label: 'Smart DOM: new template…',
    group: 'Trading',
    run: withDom((id, t) => openDesigner({ windowId: id, templateId: t.id, mode: 'new' })),
  },
  {
    id: 'dom.export-template',
    label: 'Smart DOM: export current template',
    group: 'Trading',
    run: withDom((_id, t) => {
      const url = URL.createObjectURL(
        new Blob([serializeTemplates([t])], { type: 'application/json' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = `${t.name.replace(/[^\w.-]+/g, '_')}.dom-template.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }),
  },
  {
    id: 'dom.recenter',
    label: 'Smart DOM: re-centre',
    group: 'Trading',
    shortcut: 'C',
    scope: 'trading',
    run: withDom((id) => domControllers.get(id)?.recenter()),
  },
  {
    id: 'dom.scroll-up',
    label: 'Smart DOM: scroll up',
    group: 'Trading',
    shortcut: 'PageUp',
    scope: 'trading',
    run: withDom((id) => domControllers.get(id)?.scroll(10)),
  },
  {
    id: 'dom.scroll-down',
    label: 'Smart DOM: scroll down',
    group: 'Trading',
    shortcut: 'PageDown',
    scope: 'trading',
    run: withDom((id) => domControllers.get(id)?.scroll(-10)),
  },
  ...[1, 2, 5, 10].map((g) => ({
    id: `dom.grouping.${g}`,
    label: `Smart DOM: price grouping ${g} tick${g > 1 ? 's' : ''}`,
    group: 'Trading' as const,
    run: withDom((id) => useWindows.getState().patch(id, { grouping: g })),
  })),
  ...COLUMN_DEFS.map((c) => ({
    id: `dom.column.${c.id}`,
    label: `Smart DOM: toggle column ${label(c.id)}`,
    group: 'Trading' as const,
    keywords: 'dom column show hide',
    run: withDom((_id, t) => domStore.save(toggleColumn(t, c.id))),
  })),
  ...(['session', 'range'] as const).map((v) => ({
    id: `dom.volume-scope.${v}`,
    label: `Smart DOM: volume at price — ${v === 'session' ? 'session' : 'rolling range'}`,
    group: 'Trading' as const,
    run: withDom((_id, t) =>
      domStore.save({ ...t, behaviour: { ...t.behaviour, volumeScope: v } }),
    ),
  })),
  ...(['next', 'previous'] as const).map((dir) => ({
    id: `dom.lots.${dir}`,
    label: `Smart DOM: ${dir} lot preset`,
    group: 'Trading' as const,
    run: withDom((id, t, _i, lots) => {
      const ps = t.behaviour.lotPresets;
      const i = ps.indexOf(lots);
      const n = dir === 'next' ? Math.min(ps.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1);
      useWindows.getState().patch(id, { lots: ps[n]! });
    }),
  })),
  {
    id: 'dom.buy-market',
    label: 'Smart DOM: buy market',
    group: 'Trading',
    run: withDom((_id, _t, inst, lots) =>
      domActions.place({ instrumentId: inst, side: 'buy', type: 'market', qty: lots }),
    ),
  },
  {
    id: 'dom.sell-market',
    label: 'Smart DOM: sell market',
    group: 'Trading',
    run: withDom((_id, _t, inst, lots) =>
      domActions.place({ instrumentId: inst, side: 'sell', type: 'market', qty: lots }),
    ),
  },
  {
    id: 'dom.cancel-all',
    label: 'Smart DOM: cancel all orders',
    group: 'Trading',
    run: withDom((_id, _t, inst) => domActions.cancelAll(inst)),
  },
  {
    id: 'dom.cancel-bids',
    label: 'Smart DOM: cancel buy orders',
    group: 'Trading',
    run: withDom((_id, _t, inst) => domActions.cancelAll(inst, 'buy')),
  },
  {
    id: 'dom.cancel-asks',
    label: 'Smart DOM: cancel sell orders',
    group: 'Trading',
    run: withDom((_id, _t, inst) => domActions.cancelAll(inst, 'sell')),
  },
  {
    id: 'dom.flatten',
    label: 'Smart DOM: flatten',
    group: 'Trading',
    run: withDom((_id, _t, inst) => domActions.flatten(inst)),
  },
  {
    id: 'dom.reverse',
    label: 'Smart DOM: reverse position',
    group: 'Trading',
    run: withDom((_id, _t, inst) => domActions.reverse(inst)),
  },
  {
    id: 'dom.lock',
    label: 'Smart DOM: lock / unlock trading',
    group: 'Trading',
    run: withDom((_id, _t, inst) => domActions.toggleLock(inst)),
  },
  {
    id: 'dom.notes.clear',
    label: 'Smart DOM: clear price notes',
    group: 'Trading',
    run: withDom((_id, _t, inst) => domStore.clearNotes(inst)),
  },
];

registerCommands(cmds);
