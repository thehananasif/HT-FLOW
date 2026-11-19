import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getVersion } from '@tauri-apps/api/app';
import { BackendError, type Backend, type SessionInfo } from './types';
import { LockedSaves } from './lockedSaves';

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && 'message' in e) {
      const err = e as { code: string; message: string };
      throw new BackendError(err.code, err.message);
    }
    throw new BackendError('internal', String(e));
  }
}

/** Tauri IPC bridge to the Rust core (crates/auth, crates/vault, connectors). */
export function createTauriBackend(): Backend {
  const win = getCurrentWindow();
  const held = new LockedSaves();
  const saveRaw = (key: string, value: string) => call<void>('settings_set', { key, value });
  /** A session started: write the settings saved while locked (same profile only). */
  const started = <T extends SessionInfo | null>(s: T): T => {
    if (s) {
      for (const [key, value] of held.started(s.profileId))
        void saveRaw(key, value).catch(() => {});
    }
    return s;
  };
  return {
    kind: 'tauri',
    listProfiles: () => call('auth_list_profiles'),
    createAccount: async (input) => {
      const r = await call<{ session: SessionInfo; recoveryCode: string[] }>(
        'auth_create_account',
        { input },
      );
      started(r.session);
      return r;
    },
    login: async (username, password, remember) =>
      started(await call<SessionInfo>('auth_login', { username, password, remember })),
    autoLogin: async () => started(await call<SessionInfo | null>('auth_auto_login')),
    unlockWithPin: async (username, pin) =>
      started(await call<SessionInfo>('auth_unlock_pin', { username, pin })),
    setPin: (pin) => call('auth_set_pin', { pin }),
    changePassword: (oldPassword, newPassword) =>
      call('auth_change_password', { oldPassword, newPassword }),
    recover: (username, words, newPassword) =>
      call('auth_recover', { username, words, newPassword }),
    lock: () => call('auth_lock'),
    logout: async () => {
      held.clear();
      await call<void>('auth_logout');
    },
    exportProfile: () => call('auth_export_profile'),
    importProfile: (bundle) => call('auth_import_profile', { bundle }),
    loadSettings: async <T>(key: string) => {
      const raw = await call<string | null>('settings_get', { key });
      return raw === null ? null : (JSON.parse(raw) as T);
    },
    saveSettings: async (key, value) => {
      const json = JSON.stringify(value);
      try {
        await saveRaw(key, json);
      } catch (e) {
        // Locked: keep the value and write it after the PIN / password unlock.
        if (e instanceof BackendError && e.code === 'auth.locked') held.hold(key, json);
        else throw e;
      }
    },
    vaultPut: (key, secret) => call('vault_put', { key, secret }),
    vaultGet: (key) => call('vault_get', { key }),
    appVersion: () => getVersion(),
    window: {
      minimize: () => void win.minimize(),
      toggleMaximize: () => void win.toggleMaximize(),
      close: () => void win.close(),
    },
  };
}
