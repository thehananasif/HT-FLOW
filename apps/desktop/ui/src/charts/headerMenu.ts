/** Chart window header pieces (template menu entries, settings button) used by WindowHeader. */
import type { MenuEntry } from '@htflow/ui-kit';
import { chartAction } from './bus';
import { extState } from './settings/state';
import { useChartSettingsUi } from './settingsUi';
import { applyTemplateTo, useChartTemplates } from './templateStore';
import { allTemplates } from './templates';
import { useWindows } from '../state/windows';
import { deleteSnapshot, restoreSnapshot, takeSnapshot, useChartSnapshots } from './snapshotStore';

export { openChartSettings } from './commands';

/**
 * Snapshots section (P31): take a snapshot of the chart's whole state, restore or delete saved
 * ones, copy the chart as PNG. Shown first in the header template menu.
 */
export function snapshotMenuItems(windowId: string): MenuEntry[] {
  const st = useChartSnapshots.getState();
  if (!st.loaded) void st.load();
  const list = st.list;
  return [
    {
      kind: 'submenu',
      id: 'snapshots',
      label: `Snapshots${list.length ? ` (${list.length})` : ''}`,
      items: [
        { id: 'snap-take', label: 'Take snapshot', onSelect: () => void takeSnapshot(windowId) },
        {
          id: 'snap',
          label: 'Copy chart as PNG',
          onSelect: () =>
            window.dispatchEvent(new CustomEvent('htflow:snapshot', { detail: windowId })),
        },
        ...(list.length
          ? [
              { kind: 'separator' as const, id: 'snap-s1' },
              { kind: 'label' as const, id: 'snap-l', label: 'Restore' },
              ...list.map((x): MenuEntry => ({
                id: `snap-r-${x.id}`,
                label: x.name,
                onSelect: () => restoreSnapshot(windowId, x.id),
              })),
              {
                kind: 'submenu' as const,
                id: 'snap-del',
                label: 'Delete snapshot',
                items: list.map((x): MenuEntry => ({
                  id: `snap-d-${x.id}`,
                  label: x.name,
                  onSelect: () => deleteSnapshot(x.id),
                })),
              },
            ]
          : [{ id: 'snap-none', label: 'No snapshots yet', disabled: true }]),
      ],
    },
  ];
}

/**
 * Template menu (P09): starred templates, my templates, then Save / Settings. Style presets sit
 * in a submenu. Snapshots come first (snapshotMenuItems).
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
