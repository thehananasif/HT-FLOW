import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getVersion } from '@tauri-apps/api/app';
import { BackendError, type Backend } from './types';

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
  return {
    kind: 'tauri',
    listProfiles: () => call('auth_list_profiles'),
    createAccount: (input) => call('auth_create_account', { input }),
    login: (username, password, remember) => call('auth_login', { username, password, remember }),
    autoLogin: () => call('auth_auto_login'),
    unlockWithPin: (username, pin) => call('auth_unlock_pin', { username, pin }),
    setPin: (pin) => call('auth_set_pin', { pin }),
    changePassword: (oldPassword, newPassword) =>
      call('auth_change_password', { oldPassword, newPassword }),
    recover: (username, words, newPassword) =>
      call('auth_recover', { username, words, newPassword }),
    lock: () => call('auth_lock'),
    logout: () => call('auth_logout'),
    exportProfile: () => call('auth_export_profile'),
    importProfile: (bundle) => call('auth_import_profile', { bundle }),
    loadSettings: async <T>(key: string) => {
      const raw = await call<string | null>('settings_get', { key });
      return raw === null ? null : (JSON.parse(raw) as T);
    },
    saveSettings: (key, value) => call('settings_set', { key, value: JSON.stringify(value) }),
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
