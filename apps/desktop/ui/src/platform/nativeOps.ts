/**
 * Native file logging, profile backups and the start-up preferences the core reads before login
 * (log folder, backup schedule, WebView2 GPU adapter). Desktop only; the web build reports
 * "not available" unless `window.__HTFLOW_NATIVE_MOCK__` is set (used by the e2e specs, which
 * record every call in `window.__HTFLOW_NATIVE_CALLS__`).
 */
import { toast } from '@htflow/ui-kit';
import { getSetting } from '../state/settings';
import { isTauri, native } from './native';

import { translateLiteral as tl } from '@htflow/i18n';
export interface BackupInfo {
  name: string;
  path: string;
}

/** Values mirrored into `<data>/native-prefs.json` (see src-tauri/src/native_prefs.rs). */
export interface NativePrefs {
  logsFolder: string;
  logsKeepDays: number;
  backupDays: number;
  maxBackups: number;
  videoAdapter: string;
}

declare global {
  interface Window {
    __HTFLOW_NATIVE_MOCK__?: boolean;
    __HTFLOW_NATIVE_CALLS__?: { cmd: string; args?: Record<string, unknown> }[];
  }
}

const mocked = () => typeof window !== 'undefined' && !!window.__HTFLOW_NATIVE_MOCK__;

/** True when the commands can run (desktop app, or the e2e mock). */
export const nativeOpsAvailable = () => isTauri || mocked();

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (mocked()) {
    (window.__HTFLOW_NATIVE_CALLS__ ??= []).push({ cmd, args });
    if (cmd === 'profile_backup_now')
      return { name: '20260101-000000', path: 'C:\\mock\\backups\\20260101-000000' } as T;
    if (cmd === 'profile_backup_prune') return 0 as T;
    if (cmd === 'open_log_folder') return 'C:\\mock\\logs' as T;
    return undefined as T;
  }
  return native<T>(cmd, args);
}

export const nativePrefsSet = (prefs: NativePrefs) => call<void>('native_prefs_set', { prefs });

export function currentNativePrefs(): NativePrefs {
  return {
    logsFolder: getSetting('logs.folder'),
    logsKeepDays: getSetting('logs.keepDays'),
    backupDays: getSetting('common.backupDays'),
    maxBackups: getSetting('common.maxBackups'),
    videoAdapter: getSetting('performance.videoAdapter'),
  };
}

const unavailable = (what: string) =>
  toast('info', what, tl('This needs the desktop app; it is not available in the web build.'));

export async function runOpenLogFolder(): Promise<void> {
  if (!nativeOpsAvailable()) return unavailable('Log folder');
  try {
    const dir = await call<string>('open_log_folder');
    toast('info', tl('Log folder opened'), dir);
  } catch (e) {
    toast('error', tl('Could not open the log folder'), e instanceof Error ? e.message : String(e));
  }
}

export async function runOpenBackupsFolder(): Promise<void> {
  if (!nativeOpsAvailable()) return unavailable('Backups folder');
  try {
    await call<void>('open_backups_folder');
  } catch (e) {
    toast(
      'error',
      tl('Could not open the backups folder'),
      e instanceof Error ? e.message : String(e),
    );
  }
}

/** Copies the sealed profile folder, then deletes the oldest backups beyond the maximum. */
export async function runBackupNow(): Promise<void> {
  if (!nativeOpsAvailable()) return unavailable('Back up now');
  try {
    const b = await call<BackupInfo>('profile_backup_now');
    const removed = await call<number>('profile_backup_prune', {
      max: getSetting('common.maxBackups'),
    });
    toast(
      'success',
      tl('Backup created'),
      `${b.name}${removed ? ` — ${removed} old backup${removed === 1 ? '' : 's'} deleted` : ''}`,
    );
  } catch (e) {
    toast('error', tl('Backup failed'), e instanceof Error ? e.message : String(e));
  }
}
