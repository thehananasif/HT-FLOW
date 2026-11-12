/**
 * The Workspaces ▾ menu: used by the ribbon button and the title-bar workspace selector.
 */
import { useEffect, type ReactElement } from 'react';
import { DropdownMenu, type MenuEntry } from '@htflow/ui-kit';
import { STARTER_WORKSPACES, sortWorkspaces, type StoredWorkspace } from '@htflow/workspace';
import {
  addStarter,
  ensureLibrary,
  exportWorkspace,
  loadWorkspace,
  pickWorkspaceFile,
  saveCurrent,
  useWorkspaces,
} from './store';
import { useWindows } from '../../state/windows';
import { runCommand } from '../../shell/commands';
import { workspaceHost } from './host';

export type WorkspacesAction = 'save-as' | 'rename' | 'manage' | 'links';

let pending: WorkspacesAction | null = null;

/** Activates the open window of a module, or opens one. */
export function openOrFocusModule(module: string): void {
  const { windows } = useWindows.getState();
  const id = Object.keys(windows).find((k) => {
    const w = windows[k]!;
    return w.kind === 'module' && w.module === module;
  });
  const host = workspaceHost();
  if (id && host?.focusWindow) host.focusWindow(id);
  else window.dispatchEvent(new CustomEvent('htflow:open-module', { detail: module }));
}

/** Opens the Workspaces window and asks it to run an action (dialogs live in the window). */
export function requestWorkspacesAction(action: WorkspacesAction): void {
  pending = action;
  openOrFocusModule('workspaces');
  // An already-open window picks the request up from the event; a new one on mount.
  window.dispatchEvent(new CustomEvent('htflow:workspaces-action', { detail: action }));
}

export function takePendingAction(): WorkspacesAction | null {
  const a = pending;
  pending = null;
  return a;
}

function wsItem(w: StoredWorkspace, prefix: string, currentId: string | null): MenuEntry {
  return {
    id: `${prefix}-${w.meta.id}`,
    label: `${w.meta.favourite ? '★ ' : ''}${w.meta.name}`,
    checked: w.meta.id === currentId,
    onSelect: () => void loadWorkspace(w.meta.id),
  };
}

export function useWorkspaceMenuItems(): MenuEntry[] {
  const lib = useWorkspaces((s) => s.lib);
  useEffect(() => void ensureLibrary(), []);
  const cur = lib.items.find((w) => w.meta.id === lib.currentId);
  const favs = sortWorkspaces(
    lib.items.filter((w) => w.meta.favourite),
    'name',
  );
  const recent = lib.recent
    .map((id) => lib.items.find((w) => w.meta.id === id))
    .filter((w): w is StoredWorkspace => !!w && !w.meta.favourite);
  const all = sortWorkspaces(lib.items, 'name');
  return [
    { kind: 'label', id: 'l', label: cur ? `Workspace: ${cur.meta.name}` : 'Workspaces' },
    {
      id: 'save',
      label: 'Save current',
      shortcut: 'Ctrl+Shift+S',
      onSelect: () => void saveCurrent(),
    },
    { id: 'save-as', label: 'Save as…', onSelect: () => requestWorkspacesAction('save-as') },
    {
      id: 'rename',
      label: 'Rename…',
      disabled: !cur,
      onSelect: () => requestWorkspacesAction('rename'),
    },
    {
      id: 'export',
      label: 'Export .htworkspace…',
      disabled: !cur,
      onSelect: () => cur && exportWorkspace(cur.meta.id),
    },
    { id: 'import', label: 'Import .htworkspace…', onSelect: () => pickWorkspaceFile() },
    ...(favs.length
      ? [
          { kind: 'separator' as const, id: 's-fav' },
          { kind: 'label' as const, id: 'l-fav', label: 'Favourites' },
          ...favs.map((w) => wsItem(w, 'fav', lib.currentId)),
        ]
      : []),
    ...(recent.length
      ? [
          { kind: 'separator' as const, id: 's-rec' },
          { kind: 'label' as const, id: 'l-rec', label: 'Recent' },
          ...recent.map((w) => wsItem(w, 'rec', lib.currentId)),
        ]
      : []),
    { kind: 'separator', id: 's-all' },
    {
      kind: 'submenu',
      id: 'all',
      label: `All workspaces (${all.length})`,
      items: all.length
        ? all.map((w) => wsItem(w, 'all', lib.currentId))
        : [{ id: 'none', label: 'No saved workspaces yet', disabled: true }],
    },
    {
      kind: 'submenu',
      id: 'starters',
      label: 'Starter workspaces',
      items: STARTER_WORKSPACES.map((s) => ({
        id: s.id,
        label: s.name,
        onSelect: () => void addStarter(s.id),
      })),
    },
    { kind: 'separator', id: 's-end' },
    {
      id: 'manager',
      label: 'Workspaces manager…',
      onSelect: () => openOrFocusModule('workspaces'),
    },
    { id: 'links', label: 'Link groups…', onSelect: () => requestWorkspacesAction('links') },
    {
      id: 'reset',
      label: 'Reset to default layout',
      onSelect: () => runCommand('layout.dom-chart-panel'),
    },
    {
      id: 'layout',
      label: 'Layout settings…',
      onSelect: () => openOrFocusModule('layout-settings'),
    },
  ];
}

export function WorkspaceMenu({ trigger }: { trigger: ReactElement }) {
  const items = useWorkspaceMenuItems();
  return <DropdownMenu items={items} trigger={trigger} />;
}
