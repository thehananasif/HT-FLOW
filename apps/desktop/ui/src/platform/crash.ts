/** P29 — local crash reporter (UI side). Reports are saved under `<data>/crashes/`; nothing is sent. */
import { create } from 'zustand';
import { isTauri, native } from './native';

export interface CrashFile {
  name: string;
  bytes: number;
  modified: number;
}

/** Plain-text report for an error caught by the error boundary or a global handler. */
export function formatError(error: unknown, extra?: string): string {
  const e = error instanceof Error ? error : new Error(String(error));
  return [
    `name: ${e.name}`,
    `message: ${e.message}`,
    '',
    'stack:',
    e.stack ?? '(none)',
    ...(extra ? ['', 'component stack:', extra] : []),
  ].join('\n');
}

/** Saves a report through the core (desktop only). Never throws. */
export async function saveCrash(kind: string, body: string): Promise<string | null> {
  if (!isTauri) return null;
  try {
    return await native<string>('crash_save', { kind, body });
  } catch {
    return null;
  }
}

export const listCrashes = () => native<CrashFile[]>('crash_list');
export const crashSummary = () => native<string>('crash_summary');
export const openCrashFolder = () => native<void>('crash_open_folder');

interface ReportDialogState {
  open: boolean;
  show(): void;
  hide(): void;
}

/** Opens the "Report a problem" dialog (mounted by PlatformHost and by the error boundary). */
export const useReportDialog = create<ReportDialogState>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}));

let installed = false;
/** Saves unhandled errors / promise rejections as crash files (desktop only; capped per session). */
export function installGlobalCrashHandlers(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  let saved = 0;
  const handle = (kind: string, reason: unknown) => {
    if (saved >= 3) return;
    saved += 1;
    void saveCrash(kind, formatError(reason));
  };
  window.addEventListener('error', (e) => handle('ui-error', e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => handle('ui-rejection', e.reason));
}
