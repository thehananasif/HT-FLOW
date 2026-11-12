/** Chart window header pieces (template menu entries, settings button) used by WindowHeader. */
import type { MenuEntry } from '@htflow/ui-kit';
import { chartAction } from './bus';
import { extState } from './settings/state';
import { useChartSettingsUi } from './settingsUi';
import { applyTemplateTo, useChartTemplates } from './templateStore';
import { allTemplates } from './templates';
import { useWindows } from '../state/windows';

export { openChartSettings } from './commands';

/**
 * Template menu (P09): Snapshots, starred templates, my templates, then Save / Settings.
 * Style presets sit in a submenu.
 */
export function templateMenuItems(windowId: string): MenuEntry[] {
  const lib = useChartTemplates.getState().lib;
  const all = allTemplates(lib);
  const w = useWindows.getState().windows[windowId];
  const active = w?.kind === 'chart' ? extState(w).templateId : undefined;
  const item = (t: (typeof all)[number]): MenuEntry => ({
    id: `utpl-${t.id}`,
    label: `${t.favourite ? '★ ' : ''}${t.name}`,
    checked: t.id === active,
    onSelect: () => applyTemplateTo(windowId, t.id),
  });
  const favs = all.filter((t) => t.favourite);
  return [
    { kind: 'separator', id: 'ts0' },
    {
      id: 'snap',
      label: 'Snapshot (copy PNG)',
      onSelect: () =>
        window.dispatchEvent(new CustomEvent('htflow:snapshot', { detail: windowId })),
    },
    ...(favs.length
      ? [{ kind: 'label' as const, id: 'tfav', label: 'Favourites' }, ...favs.map(item)]
      : []),
    ...(lib.templates.length
      ? [{ kind: 'label' as const, id: 'tmy', label: 'My templates' }, ...lib.templates.map(item)]
      : []),
    {
      kind: 'submenu',
      id: 'tpresets',
      label: 'Style presets',
      items: all.filter((t) => t.preset).map(item),
    },
    { kind: 'separator', id: 'ts1' },
    {
      id: 'tsave',
      label: 'Save current as template…',
      onSelect: () => chartAction('save-template', windowId),
    },
    {
      id: 'tmanage',
      label: 'Settings · Templates…',
      onSelect: () => useChartSettingsUi.getState().open(windowId, 'templates'),
    },
  ];
}
