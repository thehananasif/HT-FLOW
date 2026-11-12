/**
 * P30 — auto-update from GitHub Releases (free `tauri-plugin-updater`, minisign-signed artifacts).
 *
 * Reads the existing settings `about.checkUpdates` (look for updates at start-up; off by default)
 * and `about.updateChannel` (`stable` | `beta`). All network access happens in the Rust core and
 * only when a check runs. Web builds and builds without an updater public key report
 * "Updates unavailable in this build".
 */
import { create } from 'zustand';
import { toast } from '@htflow/ui-kit';
import { getSetting, settingsReady } from '../state/settings';
import { isTauri, native } from './native';

export const UNAVAILABLE = 'Updates unavailable in this build';
export const PORTABLE_MSG =
  'Portable build: download the new zip from the GitHub Releases page to update.';

export interface UpdateStatus {
  supported: boolean;
  reason: 'no-pubkey' | 'portable' | null;
  portable: boolean;
  version: string;
}

interface UpdateInfo {
  available: boolean;
  version: string | null;
  notes: string | null;
  date: string | null;
}

export type UpdatePhase =
  'idle' | 'checking' | 'unavailable' | 'uptodate' | 'available' | 'installing' | 'error';

interface UpdateState {
  open: boolean;
  phase: UpdatePhase;
  message: string;
  version: string | null;
  notes: string | null;
  show(): void;
  hide(): void;
  set(p: Partial<UpdateState>): void;
}

export const useUpdates = create<UpdateState>((set) => ({
  open: false,
  phase: 'idle',
  message: '',
  version: null,
  notes: null,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
  set: (p) => set(p),
}));

/** The channel from Settings; anything unexpected falls back to `stable`. */
export function currentChannel(): 'stable' | 'beta' {
  return getSetting('about.updateChannel') === 'beta' ? 'beta' : 'stable';
}

/** Why updates cannot run here, or `null` when they can. */
export async function unavailableReason(): Promise<string | null> {
  if (!isTauri) return UNAVAILABLE;
  try {
    const s = await native<UpdateStatus>('update_status');
    if (s.supported) return null;
    return s.reason === 'portable' ? PORTABLE_MSG : UNAVAILABLE;
  } catch {
    return UNAVAILABLE;
  }
}

/**
 * Checks for an update. `silent` (start-up check) never opens the dialog and only shows a toast
 * when a newer version exists.
 */
export async function checkForUpdates(opts: { silent?: boolean } = {}): Promise<void> {
  const u = useUpdates.getState();
  if (!opts.silent) u.show();
  if (u.phase === 'checking' || u.phase === 'installing') return;
  u.set({ phase: 'checking', message: 'Checking for updates…', version: null, notes: null });
  const why = await unavailableReason();
  if (why) {
    useUpdates.getState().set({ phase: 'unavailable', message: why });
    return;
  }
  try {
    const info = await native<UpdateInfo>('update_check', { channel: currentChannel() });
    if (info.available) {
      useUpdates.getState().set({
        phase: 'available',
        message: `HT Flow ${info.version} is available.`,
        version: info.version,
        notes: info.notes,
      });
      if (opts.silent) {
        toast('info', `HT Flow ${info.version} is available`, 'Open Check for updates to install.');
      }
    } else {
      useUpdates.getState().set({ phase: 'uptodate', message: 'You are on the latest version.' });
    }
  } catch (e) {
    useUpdates.getState().set({
      phase: 'error',
      message: e instanceof Error ? e.message : 'Update check failed',
    });
  }
}

/** Downloads, verifies and installs; the app restarts when it succeeds. */
export async function installUpdate(): Promise<void> {
  useUpdates.getState().set({ phase: 'installing', message: 'Downloading the update…' });
  try {
    await native<void>('update_install', { channel: currentChannel() });
  } catch (e) {
    useUpdates.getState().set({
      phase: 'error',
      message: e instanceof Error ? e.message : 'Update failed',
    });
  }
}

/** Start-up check when the user turned `about.checkUpdates` on. */
export function startupUpdateCheck(): void {
  void settingsReady().then(() => {
    if (getSetting('about.checkUpdates')) void checkForUpdates({ silent: true });
  });
}
