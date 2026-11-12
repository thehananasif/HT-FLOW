/**
 * Workspace library (P37 "Workspaces" window): every saved workspace with its meta, the recent
 * list and favourites. Pure functions — the app persists the result per user.
 */
import {
  LIMITS,
  newWorkspaceId,
  parseWorkspaceValue,
  type StoredWorkspace,
  type WorkspaceMeta,
} from './file';
import type { WorkspaceDoc } from './model';

export interface WorkspaceLibrary {
  version: 1;
  items: StoredWorkspace[];
  /** Most recently loaded / saved first. */
  recent: string[];
  /** The workspace the Dashboard shows (saving "current" writes here). */
  currentId: string | null;
  /** Last autosave time of the current workspace (ms). */
  autosavedAt: number;
}

export const MAX_WORKSPACES = 200;
export const MAX_RECENT = 8;

export function emptyLibrary(): WorkspaceLibrary {
  return { version: 1, items: [], recent: [], currentId: null, autosavedAt: 0 };
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** "Scalping", "Scalping (2)", "Scalping (3)"… unique, case-insensitive. */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const names = new Set([...taken].map((n) => n.toLowerCase()));
  const root = (base.trim() || 'Workspace').slice(0, LIMITS.name - 6).replace(/ \(\d+\)$/, '');
  if (!names.has(root.toLowerCase())) return root;
  for (let i = 2; ; i++) {
    const n = `${root} (${i})`;
    if (!names.has(n.toLowerCase())) return n;
  }
}

export function validateName(
  lib: WorkspaceLibrary,
  name: string,
  exceptId?: string,
): string | null {
  const n = name.trim();
  if (!n) return 'Enter a name';
  if (n.length > LIMITS.name) return `At most ${LIMITS.name} characters`;
  if (lib.items.some((w) => w.meta.id !== exceptId && w.meta.name.toLowerCase() === n.toLowerCase()))
    return 'A workspace with this name already exists';
  return null;
}

export function findWorkspace(lib: WorkspaceLibrary, id: string | null): StoredWorkspace | undefined {
  return id ? lib.items.find((w) => w.meta.id === id) : undefined;
}

export function touchRecent(lib: WorkspaceLibrary, id: string): WorkspaceLibrary {
  return { ...lib, recent: [id, ...lib.recent.filter((r) => r !== id)].slice(0, MAX_RECENT) };
}

/** Adds a new workspace from a document (Save as… / import / starter). Returns the new id. */
export function addWorkspace(
  lib: WorkspaceLibrary,
  doc: WorkspaceDoc,
  opts: { name?: string; description?: string; favourite?: boolean; starter?: string } = {},
  now = Date.now(),
): { lib: WorkspaceLibrary; id: string } {
  if (lib.items.length >= MAX_WORKSPACES)
    throw new Error(`At most ${MAX_WORKSPACES} workspaces can be saved; delete some first`);
  const id = newWorkspaceId(now);
  const name = uniqueName(
    opts.name ?? doc.name,
    lib.items.map((w) => w.meta.name),
  );
  const meta: WorkspaceMeta = {
    id,
    name,
    description: (opts.description ?? '').slice(0, LIMITS.description),
    favourite: opts.favourite ?? false,
    createdAt: now,
    updatedAt: now,
  };
  if (opts.starter) meta.starter = opts.starter;
  const ws: StoredWorkspace = { meta, doc: { ...clone(doc), name, savedAt: now } };
  return { lib: touchRecent({ ...lib, items: [...lib.items, ws] }, id), id };
}

/** Overwrites the document of an existing workspace (Save current / autosave). */
export function updateWorkspaceDoc(
  lib: WorkspaceLibrary,
  id: string,
  doc: WorkspaceDoc,
  now = Date.now(),
): WorkspaceLibrary {
  return {
    ...lib,
    items: lib.items.map((w) =>
      w.meta.id === id
        ? { meta: { ...w.meta, updatedAt: now }, doc: { ...clone(doc), name: w.meta.name, savedAt: now } }
        : w,
    ),
  };
}

export function patchMeta(
  lib: WorkspaceLibrary,
  id: string,
  patch: Partial<Pick<WorkspaceMeta, 'name' | 'description' | 'favourite'>>,
  now = Date.now(),
): WorkspaceLibrary {
  if (patch.name !== undefined) {
    const err = validateName(lib, patch.name, id);
    if (err) throw new Error(err);
  }
  return {
    ...lib,
    items: lib.items.map((w) => {
      if (w.meta.id !== id) return w;
      const meta = { ...w.meta, ...patch, updatedAt: now };
      if (patch.name !== undefined) meta.name = patch.name.trim();
      if (patch.description !== undefined)
        meta.description = patch.description.slice(0, LIMITS.description);
      return { meta, doc: { ...w.doc, name: meta.name } };
    }),
  };
}

export function renameWorkspace(
  lib: WorkspaceLibrary,
  id: string,
  name: string,
  now = Date.now(),
): WorkspaceLibrary {
  return patchMeta(lib, id, { name }, now);
}

export function toggleFavourite(lib: WorkspaceLibrary, id: string, now = Date.now()): WorkspaceLibrary {
  const w = findWorkspace(lib, id);
  return w ? patchMeta(lib, id, { favourite: !w.meta.favourite }, now) : lib;
}

export function duplicateWorkspace(
  lib: WorkspaceLibrary,
  id: string,
  now = Date.now(),
): { lib: WorkspaceLibrary; id: string } {
  const w = findWorkspace(lib, id);
  if (!w) throw new Error('Workspace not found');
  return addWorkspace(
    lib,
    w.doc,
    { name: `${w.meta.name} copy`, description: w.meta.description },
    now,
  );
}

export function deleteWorkspace(lib: WorkspaceLibrary, id: string): WorkspaceLibrary {
  return {
    ...lib,
    items: lib.items.filter((w) => w.meta.id !== id),
    recent: lib.recent.filter((r) => r !== id),
    currentId: lib.currentId === id ? null : lib.currentId,
  };
}

export type WorkspaceSort = 'name' | 'updated' | 'created' | 'favourites';

export function sortWorkspaces(items: StoredWorkspace[], sort: WorkspaceSort): StoredWorkspace[] {
  const byName = (a: StoredWorkspace, b: StoredWorkspace) =>
    a.meta.name.localeCompare(b.meta.name, undefined, { sensitivity: 'base', numeric: true });
  const list = [...items];
  switch (sort) {
    case 'name':
      return list.sort(byName);
    case 'updated':
      return list.sort((a, b) => b.meta.updatedAt - a.meta.updatedAt || byName(a, b));
    case 'created':
      return list.sort((a, b) => b.meta.createdAt - a.meta.createdAt || byName(a, b));
    case 'favourites':
      return list.sort((a, b) => Number(b.meta.favourite) - Number(a.meta.favourite) || byName(a, b));
  }
}

export function filterWorkspaces(items: StoredWorkspace[], query: string): StoredWorkspace[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (w) => w.meta.name.toLowerCase().includes(q) || w.meta.description.toLowerCase().includes(q),
  );
}

/** Restores a library from storage; invalid workspaces are dropped, never applied. */
export function readLibrary(raw: unknown, now = Date.now()): WorkspaceLibrary {
  const lib = emptyLibrary();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return lib;
  const r = raw as Record<string, unknown>;
  const seen = new Set<string>();
  for (const item of Array.isArray(r.items) ? r.items.slice(0, MAX_WORKSPACES) : []) {
    const res = parseWorkspaceValue({ format: 'htworkspace', version: 3, workspace: item }, now);
    if (!res.ok || seen.has(res.workspace.meta.id)) continue;
    seen.add(res.workspace.meta.id);
    lib.items.push(res.workspace);
  }
  lib.recent = (Array.isArray(r.recent) ? r.recent : [])
    .filter((x): x is string => typeof x === 'string' && seen.has(x))
    .slice(0, MAX_RECENT);
  lib.currentId = typeof r.currentId === 'string' && seen.has(r.currentId) ? r.currentId : null;
  lib.autosavedAt =
    typeof r.autosavedAt === 'number' && Number.isFinite(r.autosavedAt) ? r.autosavedAt : 0;
  return lib;
}
