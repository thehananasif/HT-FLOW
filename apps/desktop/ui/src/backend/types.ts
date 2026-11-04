export interface ProfileSummary {
  id: string;
  username: string;
  displayName: string;
  createdAt: number;
  hasPin: boolean;
}

export interface SessionInfo {
  profileId: string;
  username: string;
  displayName: string;
  timezone: string;
  theme: string;
}

export interface CreateAccountInput {
  displayName: string;
  username: string;
  email?: string;
  password: string;
  timezone: string;
  theme: string;
  rememberMe: boolean;
  pin?: string;
}

export interface LiveInstrumentInfo {
  id: string;
  symbol: string;
  exchange: string;
  tickSize: number;
  pricePrecision: number;
  qtyPrecision: number;
}

/**
 * Everything the UI needs from the native core. Implemented by the Tauri IPC bridge on Windows
 * and by an in-browser development fallback (WebCrypto + localStorage) for `pnpm dev:web` and tests.
 */
export interface Backend {
  readonly kind: 'tauri' | 'web';
  listProfiles(): Promise<ProfileSummary[]>;
  createAccount(
    input: CreateAccountInput,
  ): Promise<{ session: SessionInfo; recoveryCode: string[] }>;
  login(username: string, password: string, remember: boolean): Promise<SessionInfo>;
  autoLogin(): Promise<SessionInfo | null>;
  unlockWithPin(username: string, pin: string): Promise<SessionInfo>;
  setPin(pin: string | null): Promise<void>;
  changePassword(oldPassword: string, newPassword: string): Promise<void>;
  recover(username: string, words: string[], newPassword: string): Promise<void>;
  lock(): Promise<void>;
  logout(): Promise<void>;
  /** Encrypted profile bundle (.htprofile) as text. */
  exportProfile(): Promise<string>;
  importProfile(bundle: string): Promise<ProfileSummary>;
  loadSettings<T>(key: string): Promise<T | null>;
  saveSettings(key: string, value: unknown): Promise<void>;
  vaultPut(key: string, secret: string): Promise<void>;
  vaultGet(key: string): Promise<string | null>;
  appVersion(): Promise<string>;
  window: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
  };
}

export class BackendError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
