/**
 * P30 — file associations (UI side). The Rust core reads a file Windows opened with HT Flow
 * (`.htprofile`, `.htworkspace`, `.htind`, `.httemplate`) and emits `htflow:open-file`
 * with an `OpenedFile`. This module routes it to the importer registered for its kind:
 *
 *   registerOpenFileHandler('template', (file) => { …import file.text…; return true; });
 *
 * The same payload is also dispatched as a DOM `CustomEvent('htflow:open-file', { detail })` on
 * `window` for code that only wants to observe. Handlers marked `needsSession` wait until the user
 * has logged in. Kinds without a handler show an "import not available" toast.
 */
import { toast } from '@htflow/ui-kit';
import { backend } from '../backend';
import { useChartTemplates } from '../charts/templateStore';
import { importTemplates, parseTemplatesFile } from '../charts/templates';
import { useSession } from '../state/session';
import { isTauri, native, onNative } from './native';

export type OpenFileKind = 'profile' | 'workspace' | 'indicator' | 'template';

export interface OpenedFile {
  path: string;
  name: string;
  ext: string;
  kind: OpenFileKind;
  /** UTF-8 file text (empty when `error` is set). */
  text: string;
  error: string | null;
}

/** Return `false` when the file was not recognised; anything else counts as handled. */
export type OpenFileHandler = (file: OpenedFile) => boolean | void | Promise<boolean | void>;

interface Registered {
  fn: OpenFileHandler;
  needsSession: boolean;
}

const handlers = new Map<OpenFileKind, Registered>();
let waiting: OpenedFile[] = [];

/** Registers (or replaces) the importer for one file kind. Returns an unregister function. */
export function registerOpenFileHandler(
  kind: OpenFileKind,
  fn: OpenFileHandler,
  opts: { needsSession?: boolean } = {},
): () => void {
  const reg: Registered = { fn, needsSession: opts.needsSession ?? true };
  handlers.set(kind, reg);
  return () => {
    if (handlers.get(kind) === reg) handlers.delete(kind);
  };
}

export type RouteResult = 'handled' | 'waiting' | 'unhandled' | 'error';

/** Routes one opened file. Exported for tests. */
export async function routeOpenedFile(
  file: OpenedFile,
  hasSession = !!useSession.getState().session,
): Promise<RouteResult> {
  if (file.error) {
    toast('error', `Could not open ${file.name}`, file.error);
    return 'error';
  }
  if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
    window.dispatchEvent(new CustomEvent('htflow:open-file', { detail: file }));
  }
  const reg = handlers.get(file.kind);
  if (!reg) {
    toast(
      'info',
      `${file.name} opened`,
      `Importing .${file.ext} files by double-click is not available yet. Use the matching Import button.`,
    );
    return 'unhandled';
  }
  if (reg.needsSession && !hasSession) {
    waiting.push(file);
    toast('info', `${file.name} is ready`, 'Log in and it will be imported.');
    return 'waiting';
  }
  try {
    const r = await reg.fn(file);
    return r === false ? 'unhandled' : 'handled';
  } catch (e) {
    toast('error', `Could not import ${file.name}`, e instanceof Error ? e.message : String(e));
    return 'error';
  }
}

/** Imports files that arrived before the user logged in. */
export async function flushWaitingFiles(): Promise<void> {
  const files = waiting;
  waiting = [];
  for (const f of files) await routeOpenedFile(f, true);
}

// ---- built-in importers

// A profile bundle is imported from the login screen too, so it never waits for a session.
registerOpenFileHandler(
  'profile',
  async (f) => {
    const p = await backend.importProfile(f.text);
    toast('success', 'Profile imported', p.username);
  },
  { needsSession: false },
);

registerOpenFileHandler('template', async (f) => {
  const { templates, errors } = parseTemplatesFile(f.text);
  if (!templates.length) {
    toast('error', 'No chart templates found', errors[0]);
    return;
  }
  await useChartTemplates.getState().load();
  useChartTemplates.getState().update((l) => importTemplates(l, templates));
  toast('success', `Imported ${templates.length} chart template(s)`, f.name);
});

/** Attaches the core listener and drains files queued during start-up. Desktop only. */
export async function startOpenFileBridge(): Promise<() => void> {
  if (!isTauri) return () => {};
  const off = await onNative<OpenedFile>('htflow:open-file', (f) => void routeOpenedFile(f));
  try {
    const queued = await native<OpenedFile[]>('open_file_ready');
    for (const f of queued) void routeOpenedFile(f);
  } catch {
    // The core is older than the UI; nothing to drain.
  }
  return off;
}
