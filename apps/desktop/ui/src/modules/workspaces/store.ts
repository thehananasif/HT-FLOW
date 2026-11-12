/**
 * Workspaces library state (P25 / P37): saved workspaces, recent list and favourites, persisted per
 * user under `workspaces.library`. Actions talk to the Dashboard through the workspace host.
 */
import { create } from 'zustand';
import { toast } from '@htflow/ui-kit';
import {
  addWorkspace,
  deleteWorkspace as deleteFromLibrary,
  duplicateWorkspace as duplicateInLibrary,
  emptyLibrary,
  findWorkspace,
  parseWorkspaceFile,
  patchMeta,
  readLibrary,
  serializeWorkspaceFile,
  starterById,
  touchRecent,
  updateWorkspaceDoc,
  workspaceFileName,
  type StoredWorkspace,
  type WorkspaceDoc,
  type WorkspaceLibrary,
} from '@htflow/workspace';
import { backend } from '../../backend';
import { useSession } from '../../state/session';
import { log } from '../../state/log';
import { workspaceHost } from './host';

export const LIBRARY_KEY = 'workspaces.library';

interface WorkspacesState {
  lib: WorkspaceLibrary;
  loaded: boolean;
  profileId: string | null;
}

export const useWorkspaces = create<WorkspacesState>(() => ({
  lib: emptyLibrary(),
  loaded: false,
  profileId: null,
}));

let loading: Promise<void> | null = null;

/** Loads the library of the signed-in user (once per profile). */
export function ensureLibrary(): Promise<void> {
  const pid = useSession.getState().session?.profileId ?? null;
  const st = useWorkspaces.getState();
  if (st.loaded && st.profileId === pid) return Promise.resolve();
  if (loading) return loading;
  loading = backend
    .loadSettings<unknown>(LIBRARY_KEY)
    .then((raw) => useWorkspaces.setState({ lib: readLibrary(raw), loaded: true, profileId: pid }))
    .catch((e) => {
      log.error('workspaces', `Loading the workspace library failed: ${String(e)}`);
      useWorkspaces.setState({ lib: emptyLibrary(), loaded: true, profileId: pid });
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

// A different user signs in: forget the previous library.
useSession.subscribe((s, prev) => {
  const pid = s.session?.profileId;
  if (pid && pid !== prev.session?.profileId && pid !== useWorkspaces.getState().profileId)
    useWorkspaces.setState({ lib: emptyLibrary(), loaded: false, profileId: null });
});

function commit(lib: WorkspaceLibrary): void {
  useWorkspaces.setState({ lib });
  void backend.saveSettings(LIBRARY_KEY, lib).catch((e) => {
    log.error('workspaces', `Saving the workspace library failed: ${String(e)}`);
    toast('error', 'Could not save workspaces', String(e));
  });
}

const lib = () => useWorkspaces.getState().lib;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function snapshot(): WorkspaceDoc | null {
  const h = workspaceHost();
  if (!h) {
    toast('warning', 'The dashboard is not ready yet');
    return null;
  }
  return h.snapshot();
}

export function currentWorkspace(): StoredWorkspace | undefined {
  return findWorkspace(lib(), lib().currentId);
}

/** Save current: overwrites the loaded workspace, or asks for a name when none is loaded. */
export function saveCurrent(): string | null {
  const doc = snapshot();
  if (!doc) return null;
  const cur = currentWorkspace();
  if (!cur) return saveAs(doc.name);
  commit(touchRecent(updateWorkspaceDoc(lib(), cur.meta.id, doc), cur.meta.id));
  toast('success', `Saved "${cur.meta.name}"`);
  log.info('workspaces', `Saved workspace ${cur.meta.name}`);
  return cur.meta.id;
}

/** Save as…: a new library entry from the current workspace, which becomes the loaded one. */
export function saveAs(name: string, description = ''): string | null {
  const doc = snapshot();
  if (!doc) return null;
  try {
    const r = addWorkspace(lib(), doc, { name, description });
    commit({ ...r.lib, currentId: r.id });
    const saved = findWorkspace(r.lib, r.id)!;
    workspaceHost()?.rename(saved.meta.name);
    toast('success', `Saved as "${saved.meta.name}"`);
    return r.id;
  } catch (e) {
    toast('error', 'Could not save', errMsg(e));
    return null;
  }
}

/** Loads a saved workspace into the dashboard (every layout tab and window). */
export function loadWorkspace(id: string): boolean {
  const ws = findWorkspace(lib(), id);
  const h = workspaceHost();
  if (!ws || !h) return false;
  h.load(JSON.parse(JSON.stringify({ ...ws.doc, name: ws.meta.name })) as WorkspaceDoc);
  commit({ ...touchRecent(lib(), id), currentId: id });
  toast('success', `Loaded "${ws.meta.name}"`);
  log.info('workspaces', `Loaded workspace ${ws.meta.name}`);
  return true;
}

export function renameWorkspace(id: string, name: string): boolean {
  try {
    const next = patchMeta(lib(), id, { name });
    commit(next);
    if (next.currentId === id) workspaceHost()?.rename(name.trim());
    return true;
  } catch (e) {
    toast('warning', 'Cannot rename', errMsg(e));
    return false;
  }
}

export function setDescription(id: string, description: string): void {
  commit(patchMeta(lib(), id, { description }));
}

export function toggleFavourite(id: string): void {
  const w = findWorkspace(lib(), id);
  if (w) commit(patchMeta(lib(), id, { favourite: !w.meta.favourite }));
}

export function duplicateWorkspace(id: string): string | null {
  try {
    // The loaded workspace is duplicated with its live state.
    let base = lib();
    if (base.currentId === id) {
      const doc = workspaceHost()?.snapshot();
      if (doc) base = updateWorkspaceDoc(base, id, doc);
    }
    const r = duplicateInLibrary(base, id);
    commit(r.lib);
    toast('success', `Duplicated as "${findWorkspace(r.lib, r.id)!.meta.name}"`);
    return r.id;
  } catch (e) {
    toast('error', 'Could not duplicate', errMsg(e));
    return null;
  }
}

export function deleteWorkspace(id: string): void {
  const w = findWorkspace(lib(), id);
  commit(deleteFromLibrary(lib(), id));
  if (w) toast('info', `Deleted "${w.meta.name}"`);
}

/** Copies a starter into the library and loads it. */
export function addStarter(starterId: string): string | null {
  const s = starterById(starterId);
  if (!s) return null;
  try {
    const r = addWorkspace(lib(), s.build(), {
      name: s.name,
      description: s.description,
      starter: s.id,
    });
    commit(r.lib);
    loadWorkspace(r.id);
    return r.id;
  } catch (e) {
    toast('error', 'Could not add the starter', errMsg(e));
    return null;
  }
}

/** The `.htworkspace` text of a workspace (the loaded one with its live state). */
export function exportText(id: string): string | null {
  let ws = findWorkspace(lib(), id);
  if (!ws) return null;
  if (lib().currentId === id) {
    const doc = workspaceHost()?.snapshot();
    if (doc) ws = { meta: ws.meta, doc: { ...doc, name: ws.meta.name } };
  }
  return serializeWorkspaceFile(ws);
}

export function exportWorkspace(id: string): void {
  const text = exportText(id);
  const ws = findWorkspace(lib(), id);
  if (!text || !ws) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = workspaceFileName(ws.meta.name);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  toast('success', 'Workspace exported', a.download);
}

/** Imports a `.htworkspace` file into the library (not loaded). Returns the new id. */
export function importWorkspaceText(text: string, fileName = 'file'): string | null {
  const r = parseWorkspaceFile(text);
  if (!r.ok) {
    toast('error', `Cannot import ${fileName}`, r.error);
    log.warn('workspaces', `Import of ${fileName} refused: ${r.error}`);
    return null;
  }
  try {
    const { meta, doc } = r.workspace;
    const added = addWorkspace(lib(), doc, {
      name: meta.name,
      description: meta.description,
      favourite: meta.favourite,
    });
    commit(added.lib);
    const name = findWorkspace(added.lib, added.id)!.meta.name;
    toast(
      r.warnings.length ? 'warning' : 'success',
      `Imported "${name}"`,
      [r.migratedFrom < 3 ? `Upgraded from format v${r.migratedFrom}.` : '', ...r.warnings]
        .filter(Boolean)
        .join(' '),
    );
    return added.id;
  } catch (e) {
    toast('error', 'Could not import', errMsg(e));
    return null;
  }
}

export async function importWorkspaceFile(file: File): Promise<string | null> {
  if (file.size > 5_000_000) {
    toast('error', `Cannot import ${file.name}`, 'The file is larger than 5 MB');
    return null;
  }
  return importWorkspaceText(await file.text(), file.name);
}

/** Opens the system file picker for `.htworkspace` files. */
export function pickWorkspaceFile(onPicked?: (id: string) => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.htworkspace,.json,application/json';
  input.onchange = () => {
    const f = input.files?.[0];
    if (f) void importWorkspaceFile(f).then((id) => id && onPicked?.(id));
  };
  input.click();
}

/** Background autosave of the loaded workspace into the library (P37 "Autosave every 60 s"). */
export function autosaveCurrent(): void {
  const cur = currentWorkspace();
  const doc = workspaceHost()?.snapshot();
  if (!cur || !doc) return;
  const next = updateWorkspaceDoc(lib(), cur.meta.id, doc);
  commit({ ...next, autosavedAt: Date.now() });
}

/** Replaces the document of a saved workspace (Manage workspace → remove window). */
export function replaceSavedDoc(id: string, doc: WorkspaceDoc): void {
  commit(updateWorkspaceDoc(lib(), id, doc));
}
