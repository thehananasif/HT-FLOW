/**
 * Workspaces (P25 / P37): the Workspaces window, the ribbon / title-bar ▾ menu, Command Palette
 * entries for every action, background autosave into the library, and window commands
 * (Clone window, Create linked window ▸, Float / Dock).
 */
import { LINKED_KINDS, STARTER_WORKSPACES, sortWorkspaces } from '@htflow/workspace';
import { registerModule } from '../registry';
import { registerRibbonMenu } from '../../shell/ribbonMenus';
import { registerCommands, type Command } from '../../shell/commands';
import { getSetting, onSettingChange } from '../../state/settings';
import { useWindows } from '../../state/windows';
import { whenWorkspaceHost, workspaceHost } from './host';
import {
  addStarter,
  autosaveCurrent,
  currentWorkspace,
  ensureLibrary,
  exportWorkspace,
  loadWorkspace,
  pickWorkspaceFile,
  saveCurrent,
  useWorkspaces,
} from './store';
import { openOrFocusModule, requestWorkspacesAction, WorkspaceMenu } from './menu';
import { cloneWindow, createLinkedWindow } from './windowActions';
import { WorkspacesWindow } from './view';
import './styles.css';

registerModule({ id: 'workspaces', label: 'Workspaces', view: WorkspacesWindow });
registerRibbonMenu('workspaces', WorkspaceMenu);

const activeId = () => useWindows.getState().activeId;

const STATIC_COMMANDS: Command[] = [
  {
    id: 'workspace.save',
    label: 'Workspace: Save current',
    group: 'Layout',
    shortcut: 'Ctrl+Shift+S',
    run: () => void ensureLibrary().then(() => saveCurrent()),
  },
  {
    id: 'workspace.save-as',
    label: 'Workspace: Save as…',
    group: 'Layout',
    run: () => requestWorkspacesAction('save-as'),
  },
  {
    id: 'workspace.rename',
    label: 'Workspace: Rename current…',
    group: 'Layout',
    run: () => requestWorkspacesAction('rename'),
  },
  {
    id: 'workspace.import',
    label: 'Workspace: Import .htworkspace…',
    group: 'Layout',
    run: () => void ensureLibrary().then(() => pickWorkspaceFile()),
  },
  {
    id: 'workspace.export',
    label: 'Workspace: Export current .htworkspace',
    group: 'Layout',
    run: () => {
      const cur = currentWorkspace();
      if (cur) exportWorkspace(cur.meta.id);
      else requestWorkspacesAction('save-as');
    },
  },
  {
    id: 'workspace.manager',
    label: 'Workspace: Open Workspaces manager',
    group: 'Layout',
    run: () => openOrFocusModule('workspaces'),
  },
  {
    id: 'workspace.manage',
    label: 'Workspace: Manage workspace (tree)',
    group: 'Layout',
    run: () => requestWorkspacesAction('manage'),
  },
  {
    id: 'workspace.links',
    label: 'Workspace: Link groups manager',
    group: 'Layout',
    run: () => requestWorkspacesAction('links'),
  },
  {
    id: 'window.clone',
    label: 'Window: Clone active window',
    group: 'Layout',
    run: () => void cloneWindow(activeId()),
  },
  ...LINKED_KINDS.map((k): Command => ({
    id: `window.linked.${k.id}`,
    label: `Window: Create linked ${k.label}`,
    group: 'Layout',
    keywords: 'link group new window',
    run: () => void createLinkedWindow(k.id, activeId()),
  })),
  {
    id: 'window.float-toggle',
    label: 'Window: Float / dock active window',
    group: 'Layout',
    run: () => {
      const id = activeId();
      if (id) workspaceHost()?.toggleFloating?.(id);
    },
  },
  ...STARTER_WORKSPACES.map((s): Command => ({
    id: `workspace.starter.${s.id}`,
    label: `Workspace: Starter — ${s.name}`,
    group: 'Layout',
    run: () => void ensureLibrary().then(() => addStarter(s.id)),
  })),
];
registerCommands(STATIC_COMMANDS);

// One "Load workspace" command per saved workspace, kept in sync with the library.
let unLoadCmds: (() => void) | null = null;
let lastItems: unknown = null;
useWorkspaces.subscribe((s) => {
  if (s.lib.items === lastItems) return;
  lastItems = s.lib.items;
  unLoadCmds?.();
  unLoadCmds = registerCommands(
    sortWorkspaces(s.lib.items, 'name').map((w) => ({
      id: `workspace.load.${w.meta.id}`,
      label: `Workspace: Load ${w.meta.name}`,
      group: 'Layout' as const,
      keywords: w.meta.description,
      run: () => void loadWorkspace(w.meta.id),
    })),
  );
});

// Background autosave of the loaded workspace (Settings → General → Autosave interval).
let timer: ReturnType<typeof setInterval> | null = null;
function schedule(): void {
  if (timer) clearInterval(timer);
  timer = setInterval(
    () => {
      if (useWorkspaces.getState().loaded && workspaceHost()) autosaveCurrent();
    },
    getSetting('general.autosaveSec') * 1000,
  );
}
void whenWorkspaceHost().then(() => {
  void ensureLibrary();
  schedule();
  onSettingChange('general.autosaveSec', schedule);
});
