import {
  BackendError,
  type Backend,
  type CreateAccountInput,
  type ProfileSummary,
  type SessionInfo,
} from './types';

/**
 * Browser development fallback (pnpm dev:web, Playwright). NOT used by the Windows app, which keeps
 * accounts in the Rust core (Argon2id + ChaCha20-Poly1305). Here: PBKDF2-SHA256 + AES-GCM in localStorage.
 */
const LS = 'htflow.dev.profiles';
const WORDS =
  'amber anchor apple arrow atlas bamboo basin beacon birch blade bloom breeze bridge cabin canyon carbon cedar chalk cliff cloud comet coral crane crystal delta desert dune eagle ember falcon fern field flame forest frost garden glacier granite harbor hazel horizon island ivory jade jungle kettle lagoon lantern lemon lotus maple meadow meteor mint mirror'.split(
    ' ',
  );

interface StoredProfile {
  id: string;
  username: string;
  displayName: string;
  createdAt: number;
  salt: string;
  check: string;
  wrappedKeyPw: string;
  wrappedKeyRec: string;
  wrappedKeyPin?: string;
  data: Record<string, string>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b))));
const unb64 = (s: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function kdf(secret: string, salt: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: unb64(salt), iterations: 210_000 },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function seal(key: CryptoKey, data: BufferSource): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return b64(iv) + '.' + b64(ct);
}

async function open(key: CryptoKey, s: string): Promise<Uint8Array<ArrayBuffer>> {
  const [iv, ct] = s.split('.');
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv!) }, key, unb64(ct!)),
    );
  } catch {
    throw new BackendError('auth.invalid', 'Wrong password');
  }
}

export function createWebBackend(): Backend {
  const load = (): StoredProfile[] => JSON.parse(localStorage.getItem(LS) ?? '[]');
  const store = (ps: StoredProfile[]) => localStorage.setItem(LS, JSON.stringify(ps));
  let current: { profile: StoredProfile; key: CryptoKey } | null = null;

  const summary = (p: StoredProfile): ProfileSummary => ({
    id: p.id,
    username: p.username,
    displayName: p.displayName,
    createdAt: p.createdAt,
    hasPin: !!p.wrappedKeyPin,
  });
  const session = (p: StoredProfile, prefs: { timezone: string; theme: string }): SessionInfo => ({
    profileId: p.id,
    username: p.username,
    displayName: p.displayName,
    ...prefs,
  });
  const find = (username: string) => {
    const p = load().find((x) => x.username.toLowerCase() === username.toLowerCase());
    if (!p) throw new BackendError('auth.unknown_user', 'No profile with that username on this PC');
    return p;
  };
  const dataKeyFrom = async (wrapped: string, secret: string, salt: string) => {
    const raw = await open(await kdf(secret, salt), wrapped);
    return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', true, [
      'encrypt',
      'decrypt',
    ]);
  };
  const prefsOf = async (p: StoredProfile, key: CryptoKey) => {
    const raw = p.data['__prefs'];
    if (!raw) return { timezone: 'UTC', theme: 'dark' };
    return JSON.parse(dec.decode(await open(key, raw))) as { timezone: string; theme: string };
  };
  const save = (p: StoredProfile) => store(load().map((x) => (x.id === p.id ? p : x)));

  return {
    kind: 'web',
    listProfiles: async () => load().map(summary),
    async createAccount(input: CreateAccountInput) {
      if (load().some((x) => x.username.toLowerCase() === input.username.toLowerCase()))
        throw new BackendError('auth.exists', 'That username already exists on this PC');
      const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
      const dataKeyRaw = crypto.getRandomValues(new Uint8Array(32));
      const words = Array.from(
        crypto.getRandomValues(new Uint8Array(24)),
        (b) => WORDS[b % WORDS.length]!,
      );
      const p: StoredProfile = {
        id: crypto.randomUUID(),
        username: input.username,
        displayName: input.displayName,
        createdAt: Date.now(),
        salt,
        check: '',
        wrappedKeyPw: await seal(await kdf(input.password, salt), dataKeyRaw),
        wrappedKeyRec: await seal(await kdf(words.join(' '), salt), dataKeyRaw),
        data: {},
      };
      const key = await crypto.subtle.importKey('raw', dataKeyRaw, 'AES-GCM', true, [
        'encrypt',
        'decrypt',
      ]);
      if (input.pin) p.wrappedKeyPin = await seal(await kdf(input.pin, salt), dataKeyRaw);
      p.data['__prefs'] = await seal(
        key,
        enc.encode(JSON.stringify({ timezone: input.timezone, theme: input.theme })),
      );
      store([...load(), p]);
      current = { profile: p, key };
      if (input.rememberMe) sessionStorage.setItem('htflow.dev.remember', p.id);
      return {
        session: session(p, { timezone: input.timezone, theme: input.theme }),
        recoveryCode: words,
      };
    },
    async login(username, password, remember) {
      const p = find(username);
      const key = await dataKeyFrom(p.wrappedKeyPw, password, p.salt);
      current = { profile: p, key };
      if (remember) sessionStorage.setItem('htflow.dev.remember', p.id);
      return session(p, await prefsOf(p, key));
    },
    autoLogin: async () => null,
    async unlockWithPin(username, pin) {
      const p = find(username);
      if (!p.wrappedKeyPin) throw new BackendError('auth.no_pin', 'No PIN is set for this profile');
      const key = await dataKeyFrom(p.wrappedKeyPin, pin, p.salt);
      current = { profile: p, key };
      return session(p, await prefsOf(p, key));
    },
    async setPin(pin) {
      if (!current) throw new BackendError('auth.locked', 'Not logged in');
      const raw = new Uint8Array(await crypto.subtle.exportKey('raw', current.key));
      current.profile.wrappedKeyPin = pin
        ? await seal(await kdf(pin, current.profile.salt), raw)
        : undefined;
      save(current.profile);
    },
    async changePassword(oldPassword, newPassword) {
      if (!current) throw new BackendError('auth.locked', 'Not logged in');
      const p = current.profile;
      await dataKeyFrom(p.wrappedKeyPw, oldPassword, p.salt);
      const raw = new Uint8Array(await crypto.subtle.exportKey('raw', current.key));
      p.wrappedKeyPw = await seal(await kdf(newPassword, p.salt), raw);
      save(p);
    },
    async recover(username, words, newPassword) {
      const p = find(username);
      const key = await dataKeyFrom(p.wrappedKeyRec, words.join(' '), p.salt);
      const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
      p.wrappedKeyPw = await seal(await kdf(newPassword, p.salt), raw);
      save(p);
    },
    lock: async () => {
      current = null;
    },
    logout: async () => {
      current = null;
      sessionStorage.removeItem('htflow.dev.remember');
    },
    exportProfile: async () => {
      if (!current) throw new BackendError('auth.locked', 'Not logged in');
      return JSON.stringify({ format: 'htprofile-dev', version: 1, profile: current.profile });
    },
    async importProfile(bundle) {
      const parsed = JSON.parse(bundle) as { profile: StoredProfile };
      const ps = load().filter((x) => x.id !== parsed.profile.id);
      store([...ps, parsed.profile]);
      return summary(parsed.profile);
    },
    async loadSettings<T>(key: string) {
      if (!current) return null;
      const raw = current.profile.data[key];
      return raw ? (JSON.parse(dec.decode(await open(current.key, raw))) as T) : null;
    },
    async saveSettings(key, value) {
      if (!current) return;
      current.profile.data[key] = await seal(current.key, enc.encode(JSON.stringify(value)));
      save(current.profile);
    },
    async vaultPut(key, secret) {
      if (!current) throw new BackendError('auth.locked', 'Not logged in');
      current.profile.data['vault:' + key] = await seal(current.key, enc.encode(secret));
      save(current.profile);
    },
    async vaultGet(key) {
      if (!current) return null;
      const raw = current.profile.data['vault:' + key];
      return raw ? dec.decode(await open(current.key, raw)) : null;
    },
    appVersion: async () => '0.1.0-web',
    window: { minimize() {}, toggleMaximize() {}, close() {} },
  };
}
