/**
 * Typed settings store (P27 Settings & customization centre, P43 Common settings).
 *
 * Every setting is declared once in SCHEMA with its default, validation (range / enum / custom),
 * help text and the Settings page it lives on. Values are persisted per user profile through
 * `backend.saveSettings('settings', …)` (only values that differ from the default are stored),
 * loaded after login, and can be exported / imported as JSON.
 *
 * Other modules read settings with `useSetting(key)` (React) or `getSetting(key)` /
 * `onSettingChange(key, fn)` (anywhere).
 */
import { create } from 'zustand';
import { THEMES, type ThemeName, type ThemeTokens } from '@htflow/ui-kit';
import { backend, type SessionInfo } from '../backend';
import { useSession } from './session';
import { normalizeShortcut, type HotkeyOverrides, type HotkeyScope } from '../shell/commands';
import {
  BUILTIN_SOUNDS,
  MAX_CUSTOM_SOUND_BYTES,
  MAX_CUSTOM_SOUNDS,
  SOUND_EVENTS,
  type CustomSound,
  type SoundEvent,
  type SoundEventConfig,
} from '../sound/events';

// ------------------------------------------------------------------ schema types

export type SectionId =
  | 'general'
  | 'appearance'
  | 'hotkeys'
  | 'sounds'
  | 'timezones'
  | 'commission'
  | 'dataDelays'
  | 'performance'
  | 'common';

export const SECTIONS: { id: SectionId; label: string; description: string }[] = [
  {
    id: 'general',
    label: 'General',
    description: 'Language, time, autosave, confirmations and auto-lock.',
  },
  {
    id: 'appearance',
    label: 'Appearance',
    description: 'Theme, every colour token, UI scale, font size and ribbon.',
  },
  {
    id: 'hotkeys',
    label: 'Hot keys',
    description: 'Every command is rebindable. Click a shortcut to record a new one.',
  },
  {
    id: 'sounds',
    label: 'Sounds',
    description: 'A sound per event, built-in or your own .wav / .mp3.',
  },
  {
    id: 'timezones',
    label: 'Time zones',
    description: 'Application, chart axis and calendar zones; exchange clocks.',
  },
  {
    id: 'commission',
    label: 'Commission',
    description: 'Maker / taker % and per-contract round turn, per account and instrument.',
  },
  {
    id: 'dataDelays',
    label: 'Data delays',
    description: 'When a connection is shown as delayed (amber) or critical (red).',
  },
  {
    id: 'performance',
    label: 'Performance',
    description: 'Rendering, FPS cap, debug overlay and worker threads.',
  },
  {
    id: 'common',
    label: 'Common settings',
    description: 'Applies to the whole app and every window.',
  },
];

interface BaseDef<T> {
  section: SectionId;
  /** Group heading inside the page. */
  group: string;
  label: string;
  /** Tooltip help text. */
  help: string;
  default: T;
  /** Also shown on these pages (the value is the same setting). */
  alsoIn?: SectionId[];
  /** Extra search terms. */
  keywords?: string;
  /**
   * False while no module reads the value yet (stored and exported only). The Settings window
   * shows a "not used yet" hint for these.
   */
  wired?: boolean;
}

export interface NumberDef extends BaseDef<number> {
  type: 'number';
  min: number;
  max: number;
  step: number;
  unit?: string;
}
export interface BooleanDef extends BaseDef<boolean> {
  type: 'boolean';
}
export interface EnumOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
}
export interface EnumDef<T extends string = string> extends BaseDef<T> {
  type: 'enum';
  options: EnumOption<T>[];
}
export interface StringDef extends BaseDef<string> {
  type: 'string';
  maxLength: number;
  pattern?: RegExp;
  patternHint?: string;
  placeholder?: string;
}
export interface TimezoneDef extends BaseDef<string> {
  type: 'timezone';
  /** Non-IANA values accepted besides IANA zones (e.g. "app", "exchange"). */
  special?: EnumOption[];
}
export interface CustomDef<T> extends BaseDef<T> {
  type: 'custom';
  /** Which editor renders it (tokens, bindings, sounds, rules, clocks). */
  editor: 'tokens' | 'hotkeys' | 'soundEvents' | 'customSounds' | 'commissionRules' | 'clocks';
  /** Returns the cleaned value, or undefined when invalid. */
  validate(v: unknown): T | undefined;
}

export type SettingDef =
  | NumberDef
  | BooleanDef
  | EnumDef
  | StringDef
  | TimezoneDef
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | CustomDef<any>;

const num = (d: Omit<NumberDef, 'type'>): NumberDef => ({ type: 'number', ...d });
const bool = (d: Omit<BooleanDef, 'type'>): BooleanDef => ({ type: 'boolean', ...d });
const oneOf = <T extends string>(d: Omit<EnumDef<T>, 'type'>): EnumDef<T> => ({
  type: 'enum',
  ...d,
});
const str = (d: Omit<StringDef, 'type'>): StringDef => ({ type: 'string', ...d });
const tz = (d: Omit<TimezoneDef, 'type'>): TimezoneDef => ({ type: 'timezone', ...d });
const custom = <T>(d: Omit<CustomDef<T>, 'type'>): CustomDef<T> => ({ type: 'custom', ...d });

// ------------------------------------------------------------------ custom value types

export type TokenOverrides = Partial<ThemeTokens>;

export interface CommissionRule {
  id: string;
  /** Account id or "*" for every account. */
  accountId: string;
  /** Instrument id or "*" for every instrument. */
  instrumentId: string;
  /** Crypto maker fee, % of notional (negative = rebate). */
  makerPct: number;
  /** Crypto taker fee, % of notional. */
  takerPct: number;
  /** Futures commission per contract, round turn, account currency. */
  perContractRT: number;
  /** Where the numbers came from (P43: Detected / Default / Manual). */
  source: 'manual' | 'default' | 'detected';
}

export const TOKEN_KEYS = Object.keys(THEMES.dark) as (keyof ThemeTokens)[];
export const THEME_NAMES = Object.keys(THEMES) as ThemeName[];

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** "#abc" / "#AABBCC" → "#AABBCC"; anything else → undefined. */
export function normalizeHex(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(s))
    return ('#' + [...s.slice(1)].map((c) => c + c).join('')).toUpperCase();
  return undefined;
}

export function isValidTimeZone(zone: string): boolean {
  if (!zone || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function validateTokens(v: unknown): TokenOverrides | undefined {
  if (!isObj(v)) return undefined;
  const out: TokenOverrides = {};
  for (const [k, raw] of Object.entries(v)) {
    if (!(TOKEN_KEYS as string[]).includes(k)) return undefined;
    const hex = normalizeHex(raw);
    if (!hex) return undefined;
    out[k as keyof ThemeTokens] = hex;
  }
  return out;
}

const SCOPES: HotkeyScope[] = ['global', 'chart', 'trading', 'replay'];

function validateBindings(v: unknown): HotkeyOverrides | undefined {
  if (!isObj(v)) return undefined;
  const out: HotkeyOverrides = {};
  for (const [id, b] of Object.entries(v)) {
    if (id.length > 200 || !isObj(b)) return undefined;
    const o: HotkeyOverrides[string] = {};
    if (b.shortcut === null) o.shortcut = null;
    else if (typeof b.shortcut === 'string') {
      const s = normalizeShortcut(b.shortcut);
      if (!s || s.length > 40) return undefined;
      o.shortcut = s;
    } else if (b.shortcut !== undefined) return undefined;
    if (b.scope !== undefined) {
      if (!SCOPES.includes(b.scope as HotkeyScope)) return undefined;
      o.scope = b.scope as HotkeyScope;
    }
    out[id] = o;
  }
  return out;
}

export const DEFAULT_SOUND_EVENTS = Object.fromEntries(
  SOUND_EVENTS.map((e) => [e.id, { enabled: true, volume: e.volume, sound: e.sound }]),
) as Record<SoundEvent, SoundEventConfig>;

function validateSoundEvents(v: unknown): Record<SoundEvent, SoundEventConfig> | undefined {
  if (!isObj(v)) return undefined;
  const out = { ...DEFAULT_SOUND_EVENTS };
  for (const [k, raw] of Object.entries(v)) {
    if (!(k in DEFAULT_SOUND_EVENTS)) continue; // unknown event from a newer version: ignore
    if (!isObj(raw)) return undefined;
    const { enabled, volume, sound } = raw;
    if (typeof enabled !== 'boolean') return undefined;
    if (typeof volume !== 'number' || !(volume >= 0 && volume <= 100)) return undefined;
    if (
      typeof sound !== 'string' ||
      !(BUILTIN_SOUNDS.some((b) => b.id === sound) || /^custom:[\w-]{1,64}$/.test(sound))
    )
      return undefined;
    out[k as SoundEvent] = { enabled, volume: Math.round(volume), sound };
  }
  return out;
}

function validateCustomSounds(v: unknown): CustomSound[] | undefined {
  if (!Array.isArray(v) || v.length > MAX_CUSTOM_SOUNDS) return undefined;
  const out: CustomSound[] = [];
  for (const s of v) {
    if (!isObj(s)) return undefined;
    const { id, name, dataUrl } = s;
    if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id)) return undefined;
    if (typeof name !== 'string' || !name || name.length > 120) return undefined;
    if (
      typeof dataUrl !== 'string' ||
      !/^data:audio\/[\w.+-]+;base64,/.test(dataUrl) ||
      dataUrl.length > Math.ceil(MAX_CUSTOM_SOUND_BYTES * 1.37) + 100
    )
      return undefined;
    out.push({ id, name, dataUrl });
  }
  return out;
}

function validateRules(v: unknown): CommissionRule[] | undefined {
  if (!Array.isArray(v) || v.length > 200) return undefined;
  const out: CommissionRule[] = [];
  const n = (x: unknown, lo: number, hi: number) =>
    typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;
  for (const r of v) {
    if (!isObj(r)) return undefined;
    const { id, accountId, instrumentId, makerPct, takerPct, perContractRT, source } = r;
    if (typeof id !== 'string' || !id || id.length > 64) return undefined;
    if (typeof accountId !== 'string' || !accountId || accountId.length > 120) return undefined;
    if (typeof instrumentId !== 'string' || !instrumentId || instrumentId.length > 120)
      return undefined;
    if (!n(makerPct, -1, 5) || !n(takerPct, 0, 5) || !n(perContractRT, 0, 1000)) return undefined;
    if (source !== 'manual' && source !== 'default' && source !== 'detected') return undefined;
    out.push({
      id,
      accountId,
      instrumentId,
      makerPct: makerPct as number,
      takerPct: takerPct as number,
      perContractRT: perContractRT as number,
      source,
    });
  }
  return out;
}

function validateClocks(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || v.length > 20) return undefined;
  if (!v.every((x) => typeof x === 'string' && /^[a-z0-9-]{1,32}$/.test(x))) return undefined;
  return [...new Set(v as string[])];
}

const LANGUAGES: EnumOption<'en' | 'ur' | 'hi' | 'ar' | 'es' | 'ru' | 'tr' | 'zh'>[] = [
  { value: 'en', label: 'English' },
  { value: 'ur', label: 'اردو Urdu (RTL) — coming', disabled: true },
  { value: 'hi', label: 'हिन्दी Hindi — coming', disabled: true },
  { value: 'ar', label: 'العربية Arabic (RTL) — coming', disabled: true },
  { value: 'es', label: 'Español — coming', disabled: true },
  { value: 'ru', label: 'Русский — coming', disabled: true },
  { value: 'tr', label: 'Türkçe — coming', disabled: true },
  { value: 'zh', label: '中文 — coming', disabled: true },
];

const ZONE_SPECIAL: EnumOption[] = [
  { value: 'app', label: 'Same as application' },
  { value: 'exchange', label: 'Exchange time of the instrument' },
];

const THEME_LABELS: Record<ThemeName, string> = {
  dark: 'Dark',
  'dark-blue': 'Dark Blue',
  gray: 'Gray',
  light: 'Light',
  'high-contrast': 'High contrast',
};

// ------------------------------------------------------------------ schema

export const SCHEMA = {
  // ---------------------------------------------------------------- General
  'general.language': oneOf({
    section: 'general',
    group: 'Language & region',
    label: 'Language',
    help: 'User-interface language. English is complete; the other languages are being translated (RTL languages mirror the layout but never charts or numbers).',
    default: 'en',
    options: LANGUAGES,
    keywords: 'locale translation urdu hindi arabic spanish russian turkish chinese',
  }),
  'general.dateFormat': oneOf({
    section: 'general',
    group: 'Language & region',
    label: 'Date format',
    help: 'How dates are written in tables, the journal and exports.',
    default: 'YYYY-MM-DD',
    options: [
      { value: 'YYYY-MM-DD', label: '2026-03-31' },
      { value: 'DD.MM.YYYY', label: '31.03.2026' },
      { value: 'DD/MM/YYYY', label: '31/03/2026' },
      { value: 'MM/DD/YYYY', label: '03/31/2026' },
    ],
    wired: false,
  }),
  'general.firstDayOfWeek': oneOf({
    section: 'general',
    group: 'Language & region',
    label: 'First day of week',
    help: 'First column of calendars and weekly statistics.',
    default: 'monday',
    options: [
      { value: 'monday', label: 'Monday' },
      { value: 'sunday', label: 'Sunday' },
      { value: 'saturday', label: 'Saturday' },
    ],
    wired: false,
  }),
  'general.clock24h': bool({
    section: 'general',
    alsoIn: ['timezones'],
    group: 'Time',
    label: '24-hour clock',
    help: 'Show times as 14:30 instead of 2:30 PM (status bar clock, exchange clocks).',
    default: true,
  }),
  'general.startupWorkspace': oneOf({
    section: 'general',
    group: 'Workspace',
    label: 'Start-up workspace',
    help: 'What opens after login: the workspace you used last, or the default layout.',
    default: 'last',
    options: [
      { value: 'last', label: 'Last used workspace' },
      { value: 'default', label: 'Default layout (DOM + Footprint)' },
    ],
    wired: false,
  }),
  'general.autosaveSec': num({
    section: 'general',
    group: 'Workspace',
    label: 'Autosave interval',
    help: 'How often the workspace is saved in the background (layouts are also saved on every change).',
    default: 60,
    min: 10,
    max: 600,
    step: 5,
    unit: 's',
    wired: false,
  }),
  'general.confirmOrders': bool({
    section: 'general',
    group: 'Confirmations',
    label: 'Confirm before sending orders',
    help: 'Ask before every order from the Trading panel, DOM or chart.',
    default: false,
    wired: false,
  }),
  'general.confirmFlatten': bool({
    section: 'general',
    group: 'Confirmations',
    label: 'Confirm Flatten all / Cancel all',
    help: 'Ask before closing every position or cancelling every order.',
    default: true,
    wired: false,
  }),
  'general.confirmCloseWindow': bool({
    section: 'general',
    group: 'Confirmations',
    label: 'Confirm before closing a window',
    help: 'Ask before a chart / DOM / module window is closed.',
    default: false,
    wired: false,
  }),
  'general.confirmExit': bool({
    section: 'general',
    group: 'Confirmations',
    label: 'Confirm on exit',
    help: 'Ask before HT Flow is closed while positions or orders are open.',
    default: true,
    wired: false,
  }),
  'general.autoLockMin': num({
    section: 'general',
    group: 'Security',
    label: 'Auto-lock after',
    help: 'Lock HT Flow after this many minutes without mouse or keyboard activity. 0 = never.',
    default: 30,
    min: 0,
    max: 480,
    step: 1,
    unit: 'min',
    keywords: 'lock idle timeout security',
  }),

  // ---------------------------------------------------------------- Appearance
  'appearance.theme': oneOf<ThemeName>({
    section: 'appearance',
    group: 'Theme',
    label: 'Theme',
    help: 'Base theme. Token overrides below are applied on top of it.',
    default: 'dark',
    options: THEME_NAMES.map((t) => ({ value: t, label: THEME_LABELS[t] })),
    keywords: 'dark light gray blue contrast colours colors',
  }),
  'appearance.tokens': custom<TokenOverrides>({
    section: 'appearance',
    group: 'Colour tokens',
    label: 'Colour tokens',
    help: 'Override any design token of the base theme. Only overridden tokens are stored.',
    default: {},
    editor: 'tokens',
    validate: validateTokens,
    keywords: 'colour color token ' + TOKEN_KEYS.join(' '),
  }),
  'appearance.uiScale': num({
    section: 'appearance',
    group: 'Fonts & sizes',
    label: 'UI scale',
    help: 'Scales the application chrome (ribbon, panels, tables). Chart canvases stay pixel-sharp.',
    default: 100,
    min: 80,
    max: 150,
    step: 5,
    unit: '%',
    keywords: 'zoom size density',
  }),
  'appearance.fontSize': num({
    section: 'appearance',
    group: 'Fonts & sizes',
    label: 'Base font size',
    help: 'Default text size of the application (dense tables keep their 11–12 px).',
    default: 12,
    min: 10,
    max: 16,
    step: 1,
    unit: 'px',
  }),
  'appearance.ribbonIconsOnly': bool({
    section: 'appearance',
    group: 'Ribbon',
    label: 'Ribbon: icons only',
    help: 'Hide the labels under the ribbon icons to save vertical space.',
    default: false,
    keywords: 'compact toolbar',
  }),

  // ---------------------------------------------------------------- Hot keys
  'hotkeys.preset': oneOf({
    section: 'hotkeys',
    group: 'Preset',
    label: 'Preset',
    help: 'Starting point for your bindings. Applying a preset replaces your current overrides.',
    default: 'htflow',
    options: [
      { value: 'htflow', label: 'HT Flow default' },
      { value: 'scalper', label: 'Scalper' },
      { value: 'classic', label: 'Classic' },
    ],
  }),
  'hotkeys.bindings': custom<HotkeyOverrides>({
    section: 'hotkeys',
    group: 'Bindings',
    label: 'Key bindings',
    help: 'Your shortcut and scope overrides per command. Commands not listed use their defaults.',
    default: {},
    editor: 'hotkeys',
    validate: validateBindings,
    keywords: 'shortcut keyboard binding hotkey',
  }),

  // ---------------------------------------------------------------- Sounds
  'sounds.muteAll': bool({
    section: 'sounds',
    group: 'Master',
    label: 'Mute all sounds',
    help: 'Silence every sound without changing the per-event settings.',
    default: false,
    keywords: 'silent audio',
  }),
  'sounds.master': num({
    section: 'sounds',
    group: 'Master',
    label: 'Master volume',
    help: 'Multiplies every event volume.',
    default: 80,
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
  }),
  'sounds.events': custom<Record<SoundEvent, SoundEventConfig>>({
    section: 'sounds',
    group: 'Events',
    label: 'Event sounds',
    help: 'On/off, sound and volume for each event.',
    default: DEFAULT_SOUND_EVENTS,
    editor: 'soundEvents',
    validate: validateSoundEvents,
    keywords: SOUND_EVENTS.map((e) => e.label).join(' '),
  }),
  'sounds.custom': custom<CustomSound[]>({
    section: 'sounds',
    group: 'Your sounds',
    label: 'Your sound files',
    help: 'Your own .wav / .mp3 files (max 2 MB each, 20 files), stored encrypted in your profile.',
    default: [],
    editor: 'customSounds',
    validate: validateCustomSounds,
    keywords: 'wav mp3 file upload',
  }),

  // ---------------------------------------------------------------- Time zones
  'timezones.app': tz({
    section: 'timezones',
    alsoIn: ['general'],
    group: 'Zones',
    label: 'Application time zone',
    help: 'Time zone of the status-bar clock, tables, journal and logs.',
    default: 'UTC',
    keywords: 'timezone clock',
  }),
  'timezones.chartAxis': tz({
    section: 'timezones',
    alsoIn: ['general'],
    group: 'Zones',
    label: 'Chart axis time zone',
    help: 'Time zone of chart time axes and session separators.',
    default: 'app',
    special: ZONE_SPECIAL,
    wired: false,
  }),
  'timezones.calendar': tz({
    section: 'timezones',
    alsoIn: ['general'],
    group: 'Zones',
    label: 'Calendar time zone',
    help: 'Time zone of the economic calendar and news (P39).',
    default: 'app',
    special: [ZONE_SPECIAL[0]!],
    wired: false,
  }),
  'timezones.exchangeTimeOnHover': bool({
    section: 'timezones',
    group: 'Exchange clocks',
    label: 'Exchange time on hover',
    help: 'Show the exchange local time in tooltips over times (charts, tables).',
    default: true,
    wired: false,
  }),
  'timezones.clocks': custom<string[]>({
    section: 'timezones',
    group: 'Exchange clocks',
    label: 'Exchange clocks',
    help: 'Exchanges whose clock and Open / Closed status you want to follow.',
    default: ['cme', 'eurex', 'nyse', 'crypto'],
    editor: 'clocks',
    validate: validateClocks,
    keywords: 'cme globex nymex comex eurex ice nyse nasdaq crypto trading hours open closed',
  }),

  // ---------------------------------------------------------------- Commission
  'commission.cryptoMakerPct': num({
    section: 'commission',
    group: 'Defaults',
    label: 'Crypto maker fee',
    help: 'Default maker fee for crypto instruments, % of notional (negative = rebate). The paper engine currently charges maker fills at half its taker rate; this value is used by P&L, journal and backtests.',
    default: 0.02,
    min: -1,
    max: 5,
    step: 0.001,
    unit: '%',
  }),
  'commission.cryptoTakerPct': num({
    section: 'commission',
    group: 'Defaults',
    label: 'Crypto taker fee',
    help: 'Default taker fee for crypto instruments, % of notional.',
    default: 0.05,
    min: 0,
    max: 5,
    step: 0.001,
    unit: '%',
  }),
  'commission.futuresRT': num({
    section: 'commission',
    group: 'Defaults',
    label: 'Futures commission (round turn)',
    help: 'Default commission per futures contract, round turn (buy + sell), in account currency.',
    default: 4.5,
    min: 0,
    max: 1000,
    step: 0.01,
    unit: 'USD',
  }),
  'commission.rules': custom<CommissionRule[]>({
    section: 'commission',
    group: 'Rules',
    label: 'Commission rules',
    help: 'Per account and/or instrument. The most specific rule wins (account + instrument > instrument > account > defaults).',
    default: [],
    editor: 'commissionRules',
    validate: validateRules,
    keywords: 'fee maker taker round turn per contract account instrument',
  }),

  // ---------------------------------------------------------------- Data delays
  'dataDelays.warningMs': num({
    section: 'dataDelays',
    alsoIn: ['common'],
    group: 'Data delays',
    label: 'Warning data latency',
    help: 'A live connection slower than this is shown amber in the status bar.',
    default: 500,
    min: 50,
    max: 60_000,
    step: 50,
    unit: 'ms',
    keywords: 'latency delay amber',
  }),
  'dataDelays.criticalMs': num({
    section: 'dataDelays',
    alsoIn: ['common'],
    group: 'Data delays',
    label: 'Critical data latency',
    help: 'A live connection slower than this is shown red in the status bar. Must be above the warning latency.',
    default: 2000,
    min: 100,
    max: 120_000,
    step: 50,
    unit: 'ms',
    keywords: 'latency delay red',
  }),
  'dataDelays.criticalLastUpdateSec': num({
    section: 'dataDelays',
    alsoIn: ['common'],
    group: 'Data delays',
    label: 'Critical last market data update',
    help: 'A live connection with no market data for this long is shown red.',
    default: 10,
    min: 1,
    max: 3600,
    step: 1,
    unit: 's',
  }),
  'dataDelays.notificationLevel': oneOf({
    section: 'dataDelays',
    alsoIn: ['common'],
    group: 'Data delays',
    label: 'Notification level',
    help: 'Which delay level also raises a notification (besides the status-bar colour).',
    default: 'critical',
    options: [
      { value: 'none', label: 'None' },
      { value: 'warning', label: 'Warning and critical' },
      { value: 'critical', label: 'Critical' },
    ],
    wired: false,
  }),
  'dataDelays.ntpServer': str({
    section: 'dataDelays',
    alsoIn: ['common'],
    group: 'Data delays',
    label: 'NTP server',
    help: 'Time server used to measure the PC clock offset (host:port). Stored only; the clock check arrives with the native core.',
    default: 'pool.ntp.org:123',
    maxLength: 253,
    pattern: /^[a-z0-9.-]+(:\d{1,5})?$/i,
    patternHint: 'host or host:port, e.g. pool.ntp.org:123',
    wired: false,
  }),

  // ---------------------------------------------------------------- Performance (+ Common → Rendering)
  'performance.renderer': oneOf({
    section: 'performance',
    alsoIn: ['common'],
    group: 'Rendering',
    label: 'Renderer type',
    help: 'Chart renderer. Auto uses WebGL2 where the chart supports it and Canvas 2D otherwise.',
    default: 'auto',
    options: [
      { value: 'auto', label: 'Auto' },
      { value: 'webgl2', label: 'WebGL2 (GPU)' },
      { value: 'canvas2d', label: 'Canvas 2D' },
    ],
    wired: false,
  }),
  'performance.videoAdapter': oneOf({
    section: 'performance',
    alsoIn: ['common'],
    group: 'Rendering',
    label: 'Video adapter',
    help: 'GPU preference on PCs with integrated + discrete graphics (applied on next start).',
    default: 'auto',
    options: [
      { value: 'auto', label: 'Auto' },
      { value: 'high-performance', label: 'Discrete (high performance)' },
      { value: 'low-power', label: 'Integrated (low power)' },
    ],
    wired: false,
  }),
  'performance.showDebugInfo': bool({
    section: 'performance',
    alsoIn: ['common'],
    group: 'Rendering',
    label: 'Show debug info',
    help: 'FPS / frame-time / memory overlay in the top-right corner.',
    default: false,
    keywords: 'fps overlay',
  }),
  'performance.disableHiddenRendering': bool({
    section: 'performance',
    alsoIn: ['common'],
    group: 'Rendering',
    label: 'Disable hidden windows rendering',
    help: 'Windows in background tabs stop drawing until they are visible again.',
    default: true,
  }),
  'performance.fpsCap': num({
    section: 'performance',
    group: 'Rendering',
    label: 'FPS cap',
    help: 'Upper limit of chart frames per second. 0 = display refresh rate.',
    default: 60,
    min: 0,
    max: 240,
    step: 5,
    unit: 'fps',
    wired: false,
  }),
  'performance.workerCount': num({
    section: 'performance',
    alsoIn: ['common'],
    group: 'Rendering',
    label: 'Render / worker threads',
    help: 'Web workers used for indicators, bar building and rendering (applied on next start).',
    default: 2,
    min: 1,
    max: 16,
    step: 1,
    wired: false,
  }),

  // ---------------------------------------------------------------- Common settings (board 19)
  'common.vaPercent': num({
    section: 'common',
    group: 'Value Area',
    label: 'Value Area percent',
    help: 'Share of volume inside the value area of every volume profile.',
    default: 70,
    min: 50,
    max: 95,
    step: 1,
    unit: '%',
    wired: false,
  }),
  'common.vaLevelsAtTime': num({
    section: 'common',
    group: 'Value Area',
    label: 'Levels at a time',
    help: 'Price levels added per step when the value area is grown around the POC.',
    default: 2,
    min: 1,
    max: 10,
    step: 1,
    wired: false,
  }),
  'common.vaUpdateMs': num({
    section: 'common',
    group: 'Value Area',
    label: 'Update interval',
    help: 'How often live value areas are recomputed.',
    default: 1000,
    min: 100,
    max: 10_000,
    step: 100,
    unit: 'ms',
    wired: false,
  }),
  'common.aiButton': bool({
    section: 'common',
    group: 'AI assistant',
    label: 'Show the button in the window header',
    help: 'Show the local AI assistant button in every window header.',
    default: true,
    wired: false,
  }),
  'common.continuousProfileSource': oneOf({
    section: 'common',
    group: 'Common',
    label: 'Continuous profile source',
    help: 'Which contract feeds continuous profiles on futures.',
    default: 'current',
    options: [
      { value: 'current', label: 'Current contract' },
      { value: 'continuous', label: 'Continuous contract' },
    ],
    wired: false,
  }),
  'common.maxCandlesPerChart': num({
    section: 'common',
    group: 'Common',
    label: 'Max candles per chart',
    help: 'Older bars are dropped beyond this count to keep memory bounded.',
    default: 100_000,
    min: 1000,
    max: 1_000_000,
    step: 1000,
    wired: false,
  }),
  'common.defaultLoadDays': num({
    section: 'common',
    group: 'Common',
    label: 'Default load days',
    help: 'History loaded when a chart opens.',
    default: 4,
    min: 1,
    max: 365,
    step: 1,
    unit: 'days',
    wired: false,
  }),
  'common.mboStoreRaw': bool({
    section: 'common',
    group: 'MBO analytics',
    label: 'Store raw MBO history',
    help: 'Keep raw market-by-order events (large).',
    default: false,
    wired: false,
  }),
  'common.mboStoreOnDisk': bool({
    section: 'common',
    group: 'MBO analytics',
    label: 'Store MBO history on disk',
    help: 'Persist MBO analytics (annotated trades, icebergs) to the tick store.',
    default: true,
    wired: false,
  }),
  'common.mboRawDays': num({
    section: 'common',
    group: 'MBO analytics',
    label: 'Raw MBO history, days',
    help: 'Days of raw MBO events kept.',
    default: 1,
    min: 1,
    max: 30,
    step: 1,
    unit: 'days',
    wired: false,
  }),
  'common.mboAnnotatedDays': num({
    section: 'common',
    group: 'MBO analytics',
    label: 'Annotated trades history, days',
    help: 'Days of annotated trades kept.',
    default: 1,
    min: 1,
    max: 90,
    step: 1,
    unit: 'days',
    wired: false,
  }),
  'common.mboIcebergDays': num({
    section: 'common',
    group: 'MBO analytics',
    label: 'Icebergs history, days',
    help: 'Days of detected icebergs kept.',
    default: 1,
    min: 1,
    max: 90,
    step: 1,
    unit: 'days',
    wired: false,
  }),
  'common.heatmapAdapter': oneOf({
    section: 'common',
    group: 'Heatmap rendering',
    label: 'Video adapter',
    help: 'GPU used by the heatmap / liquidity map renderer.',
    default: 'auto',
    options: [
      { value: 'auto', label: 'Auto' },
      { value: 'high-performance', label: 'Discrete (high performance)' },
      { value: 'low-power', label: 'Integrated (low power)' },
    ],
    wired: false,
  }),
  'common.heatmapFpsMode': oneOf({
    section: 'common',
    group: 'Heatmap rendering',
    label: 'FPS cap mode',
    help: 'Auto follows the display; Manual uses the cap below.',
    default: 'auto',
    options: [
      { value: 'auto', label: 'Auto' },
      { value: 'manual', label: 'Manual' },
    ],
    wired: false,
  }),
  'common.heatmapFpsCap': num({
    section: 'common',
    group: 'Heatmap rendering',
    label: 'Manual FPS cap',
    help: 'Heatmap frames per second when the cap mode is Manual.',
    default: 60,
    min: 5,
    max: 240,
    step: 5,
    unit: 'fps',
    wired: false,
  }),
  'common.heatmapStartupLevels': num({
    section: 'common',
    group: 'Heatmap rendering',
    label: 'Startup levels (+/−)',
    help: 'Price levels above and below the last price shown when a heatmap opens.',
    default: 60,
    min: 10,
    max: 1000,
    step: 10,
    wired: false,
  }),
  'common.backupDays': num({
    section: 'common',
    group: 'Database & recorder',
    label: 'Backup period',
    help: 'How often the local database is backed up.',
    default: 1,
    min: 1,
    max: 30,
    step: 1,
    unit: 'days',
    wired: false,
  }),
  'common.maxBackups': num({
    section: 'common',
    group: 'Database & recorder',
    label: 'Maximum store backups',
    help: 'Older backups are deleted.',
    default: 10,
    min: 1,
    max: 100,
    step: 1,
    wired: false,
  }),
  'common.recorderMaxGb': num({
    section: 'common',
    group: 'Database & recorder',
    label: 'Recorder max disk',
    help: 'Disk budget of the tick / depth recorder.',
    default: 50,
    min: 1,
    max: 2000,
    step: 1,
    unit: 'GB',
    wired: false,
  }),
  'common.tickRetentionDays': num({
    section: 'common',
    group: 'Database & recorder',
    label: 'Tick history retention',
    help: 'Recorded ticks older than this are pruned.',
    default: 90,
    min: 1,
    max: 3650,
    step: 1,
    unit: 'days',
    wired: false,
  }),
  'common.domLevels': num({
    section: 'common',
    group: 'Depth of market',
    label: 'Levels count (0 = all)',
    help: 'Book levels kept per side for DOM windows.',
    default: 0,
    min: 0,
    max: 1000,
    step: 1,
    wired: false,
  }),
  'common.domHeatmapLevels': num({
    section: 'common',
    group: 'Depth of market',
    label: 'Heatmap levels count (0 = all)',
    help: 'Book levels kept per side for heatmaps.',
    default: 0,
    min: 0,
    max: 1000,
    step: 1,
    wired: false,
  }),
  'common.strategiesUnusedDays': num({
    section: 'common',
    group: 'Strategies',
    label: 'Unused storage time',
    help: 'Stored data of strategies not run for this long is removed.',
    default: 30,
    min: 1,
    max: 365,
    step: 1,
    unit: 'days',
    wired: false,
  }),
  'common.notifyShow': bool({
    section: 'common',
    group: 'Notifications',
    label: 'Show notification',
    help: 'Show pop-up notifications (fills, alerts, connection changes).',
    default: true,
    wired: false,
  }),
  'common.notifyDurationMs': num({
    section: 'common',
    group: 'Notifications',
    label: 'Duration',
    help: 'How long a notification stays on screen.',
    default: 5000,
    min: 1000,
    max: 60_000,
    step: 500,
    unit: 'ms',
    wired: false,
  }),
  'common.notifyMax': num({
    section: 'common',
    group: 'Notifications',
    label: 'Max count',
    help: 'Maximum notifications on screen at once.',
    default: 10,
    min: 1,
    max: 50,
    step: 1,
    wired: false,
  }),
  'common.notifyPosition': oneOf({
    section: 'common',
    group: 'Notifications',
    label: 'Position',
    help: 'Screen corner of the notification stack.',
    default: 'bottom-right',
    options: [
      { value: 'bottom-right', label: 'Bottom right' },
      { value: 'bottom-left', label: 'Bottom left' },
      { value: 'top-right', label: 'Top right' },
      { value: 'top-left', label: 'Top left' },
    ],
  }),
  'common.tradingNoWarnings': bool({
    section: 'common',
    group: 'Trading',
    label: 'Do not show warnings',
    help: 'Hide non-blocking trading warnings (e.g. order far from market).',
    default: false,
    wired: false,
  }),
  'common.skipTableConfirmations': bool({
    section: 'common',
    group: 'Trading',
    label: 'Skip confirmations in tables',
    help: 'Cancel / close from the Orders and Positions tables without asking.',
    default: false,
    wired: false,
  }),
  'common.crossTrading': bool({
    section: 'common',
    group: 'Trading',
    label: 'Enable cross-trading',
    help: 'Allow opposite orders on the same instrument from different accounts.',
    default: false,
    wired: false,
  }),
  'common.bestPricesIndicator': bool({
    section: 'common',
    group: 'Trading',
    label: 'Auto add/remove best prices indicator',
    help: 'Add the best bid/ask indicator to charts when trading from them.',
    default: false,
    wired: false,
  }),
  'common.closeDontAsk': bool({
    section: 'common',
    group: 'Closing modules',
    label: "Don't ask again",
    help: 'Close module windows without a confirmation.',
    default: true,
    wired: false,
  }),
  'common.closeDontAskToday': bool({
    section: 'common',
    group: 'Closing modules',
    label: "Don't ask today",
    help: 'Skip close confirmations until midnight.',
    default: false,
    wired: false,
  }),
} satisfies Record<string, SettingDef>;

type ValueOf<D> = D extends BaseDef<infer T> ? T : never;

export type SettingKey = keyof typeof SCHEMA;
export type SettingsValues = { [K in SettingKey]: ValueOf<(typeof SCHEMA)[K]> };

export const SETTING_KEYS = Object.keys(SCHEMA) as SettingKey[];

export function settingDef(key: SettingKey): SettingDef {
  return SCHEMA[key] as SettingDef;
}

/** Settings shown on a page (home section or `alsoIn`), in schema order. */
export function sectionKeys(section: SectionId): SettingKey[] {
  return SETTING_KEYS.filter((k) => {
    const d = settingDef(k);
    return d.section === section || d.alsoIn?.includes(section);
  });
}

export const STATIC_DEFAULTS = Object.fromEntries(
  SETTING_KEYS.map((k) => [k, settingDef(k).default]),
) as SettingsValues;

/** Profile-specific defaults: the theme and time zone chosen when the account was created. */
export function profileDefaults(s: Pick<SessionInfo, 'theme' | 'timezone'> | null): SettingsValues {
  const d = { ...STATIC_DEFAULTS };
  if (s && THEME_NAMES.includes(s.theme as ThemeName)) d['appearance.theme'] = s.theme as ThemeName;
  if (s && isValidTimeZone(s.timezone)) d['timezones.app'] = s.timezone;
  return d;
}

// ------------------------------------------------------------------ validation

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

const decimals = (step: number) => (String(step).split('.')[1] ?? '').length;

export function validateSetting<K extends SettingKey>(
  key: K,
  raw: unknown,
): ValidationResult<SettingsValues[K]> {
  const d = settingDef(key);
  const ok = (v: unknown) => ({ ok: true as const, value: v as SettingsValues[K] });
  const fail = (error: string) => ({ ok: false as const, error });
  switch (d.type) {
    case 'number': {
      const n =
        typeof raw === 'number'
          ? raw
          : typeof raw === 'string' && raw.trim() !== ''
            ? Number(raw)
            : NaN;
      if (!Number.isFinite(n)) return fail('Enter a number');
      if (n < d.min || n > d.max)
        return fail(`Must be between ${d.min} and ${d.max}${d.unit ? ' ' + d.unit : ''}`);
      const snapped = Number((Math.round(n / d.step) * d.step).toFixed(decimals(d.step)));
      return ok(Math.min(d.max, Math.max(d.min, snapped)));
    }
    case 'boolean':
      return typeof raw === 'boolean' ? ok(raw) : fail('Must be on or off');
    case 'enum': {
      const o = d.options.find((x) => x.value === raw);
      if (!o) return fail('Not one of the allowed values');
      if (o.disabled) return fail(`${o.label.replace(/ — coming$/, '')} is not available yet`);
      return ok(raw);
    }
    case 'string': {
      if (typeof raw !== 'string') return fail('Must be text');
      const s = raw.trim();
      if (s.length > d.maxLength) return fail(`At most ${d.maxLength} characters`);
      if (d.pattern && !d.pattern.test(s)) return fail(d.patternHint ?? 'Invalid format');
      return ok(s);
    }
    case 'timezone': {
      if (typeof raw !== 'string') return fail('Must be a time zone');
      if (d.special?.some((o) => o.value === raw) || isValidTimeZone(raw)) return ok(raw);
      return fail('Unknown time zone');
    }
    case 'custom': {
      const v = d.validate(raw);
      return v === undefined ? fail('Invalid value') : ok(v);
    }
  }
}

/** Rules between settings (e.g. critical latency above warning). */
export function crossErrors(v: SettingsValues): Partial<Record<SettingKey, string>> {
  const e: Partial<Record<SettingKey, string>> = {};
  if (v['dataDelays.criticalMs'] <= v['dataDelays.warningMs'])
    e['dataDelays.criticalMs'] = 'Critical latency must be above the warning latency';
  return e;
}

export const sameValue = (a: unknown, b: unknown): boolean =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

/** Validates a whole (partial) value map; invalid / unknown keys are reported, never applied. */
export function sanitizeValues(
  raw: unknown,
  base: SettingsValues,
): { values: SettingsValues; errors: string[]; applied: number } {
  const values = { ...base };
  const errors: string[] = [];
  let applied = 0;
  if (!isObj(raw)) return { values, errors: ['Settings must be a JSON object'], applied };
  for (const [k, v] of Object.entries(raw)) {
    if (!(k in SCHEMA)) {
      errors.push(`${k}: unknown setting (ignored)`);
      continue;
    }
    const r = validateSetting(k as SettingKey, v);
    if (r.ok) {
      (values as Record<string, unknown>)[k] = r.value;
      applied++;
    } else errors.push(`${k}: ${r.error}`);
  }
  for (const [k, msg] of Object.entries(crossErrors(values))) {
    errors.push(`${k}: ${msg} (kept previous value)`);
    (values as Record<string, unknown>)[k] = base[k as SettingKey];
  }
  return { values, errors, applied };
}

/** Values that differ from the defaults (what is persisted). */
export function modifiedValues(
  values: SettingsValues,
  defaults: SettingsValues,
): Partial<SettingsValues> {
  const out: Partial<SettingsValues> = {};
  for (const k of SETTING_KEYS)
    if (!sameValue(values[k], defaults[k]))
      (out as Record<string, unknown>)[k] = values[k] as unknown;
  return out;
}

// ------------------------------------------------------------------ store

interface SettingsStore {
  values: SettingsValues;
  defaults: SettingsValues;
  profileId: string | null;
  /** True once the logged-in profile's settings were read. */
  loaded: boolean;
}

export const useSettingsStore = create<SettingsStore>(() => ({
  values: STATIC_DEFAULTS,
  defaults: STATIC_DEFAULTS,
  profileId: null,
  loaded: false,
}));

/** React selector: re-renders when this setting changes. */
export function useSetting<K extends SettingKey>(key: K): SettingsValues[K] {
  return useSettingsStore((s) => s.values[key]);
}

export function getSetting<K extends SettingKey>(key: K): SettingsValues[K] {
  return useSettingsStore.getState().values[key];
}

export function getSettings(): SettingsValues {
  return useSettingsStore.getState().values;
}

export function getDefaults(): SettingsValues {
  return useSettingsStore.getState().defaults;
}

export function isModified(key: SettingKey, values = getSettings(), defaults = getDefaults()) {
  return !sameValue(values[key], defaults[key]);
}

/** Calls fn whenever the setting changes (also when a profile is loaded). */
export function onSettingChange<K extends SettingKey>(
  key: K,
  fn: (value: SettingsValues[K], prev: SettingsValues[K]) => void,
): () => void {
  return useSettingsStore.subscribe((s, p) => {
    if (s.values[key] !== p.values[key]) fn(s.values[key], p.values[key]);
  });
}

/**
 * Validates and applies a patch. Returns the errors of rejected keys (valid keys are applied).
 */
export function setSettings(
  patch: Partial<Record<SettingKey, unknown>>,
): Partial<Record<SettingKey, string>> {
  const cur = getSettings();
  const next = { ...cur };
  const errors: Partial<Record<SettingKey, string>> = {};
  for (const [k, v] of Object.entries(patch) as [SettingKey, unknown][]) {
    const r = validateSetting(k, v);
    if (r.ok) (next as Record<string, unknown>)[k] = r.value;
    else errors[k] = r.error;
  }
  for (const [k, msg] of Object.entries(crossErrors(next)) as [SettingKey, string][]) {
    errors[k] = msg;
    (next as Record<string, unknown>)[k] = cur[k];
  }
  let changed = false;
  for (const k of SETTING_KEYS)
    if (!sameValue(next[k], cur[k])) changed = true;
    else (next as Record<string, unknown>)[k] = cur[k]; // keep identity for selectors
  if (changed) useSettingsStore.setState({ values: next });
  return errors;
}

export function setSetting<K extends SettingKey>(key: K, value: SettingsValues[K]): string | null {
  return setSettings({ [key]: value } as Partial<Record<SettingKey, unknown>>)[key] ?? null;
}

export function resetSettings(keys: SettingKey[]): void {
  const d = getDefaults();
  setSettings(Object.fromEntries(keys.map((k) => [k, d[k]])));
}

export function resetSection(section: SectionId): void {
  resetSettings(sectionKeys(section));
}

export function resetAllSettings(): void {
  useSettingsStore.setState({ values: { ...getDefaults() } });
}

// ------------------------------------------------------------------ export / import

export interface SettingsFile {
  app: 'HT Flow';
  kind: 'htflow-settings';
  version: 1;
  exportedAt: string;
  values: Partial<SettingsValues>;
}

/** Full export (every value, not only the modified ones) so another profile reproduces it exactly. */
export function exportSettings(values: SettingsValues = getSettings()): SettingsFile {
  return {
    app: 'HT Flow',
    kind: 'htflow-settings',
    version: 1,
    exportedAt: new Date().toISOString(),
    values: { ...values },
  };
}

/**
 * Parses an exported file (object or JSON text) into a complete value map: keys present in the file
 * replace the defaults; invalid keys are reported and keep the default.
 */
export function parseSettingsFile(
  input: unknown,
  defaults: SettingsValues = getDefaults(),
): { values: SettingsValues; errors: string[]; applied: number } {
  let data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch {
      return { values: defaults, errors: ['Not a valid JSON file'], applied: 0 };
    }
  }
  if (!isObj(data) || data.kind !== 'htflow-settings' || !isObj(data.values))
    return { values: defaults, errors: ['Not an HT Flow settings file'], applied: 0 };
  if (typeof data.version === 'number' && data.version > 1)
    return {
      values: defaults,
      errors: ['This file was exported by a newer HT Flow version'],
      applied: 0,
    };
  return sanitizeValues(data.values, defaults);
}

export function importSettings(input: unknown): { applied: number; errors: string[] } {
  const r = parseSettingsFile(input);
  if (r.applied === 0 && r.errors.length) return { applied: 0, errors: r.errors };
  useSettingsStore.setState({ values: r.values });
  return { applied: r.applied, errors: r.errors };
}

// ------------------------------------------------------------------ data-delay helper

export type DelayLevel = 'ok' | 'warning' | 'critical';

/** Classifies a live connection by latency and time since its last market-data update. */
export function classifyDelay(
  latencyMs: number,
  sinceLastUpdateMs = 0,
  v: Pick<
    SettingsValues,
    'dataDelays.warningMs' | 'dataDelays.criticalMs' | 'dataDelays.criticalLastUpdateSec'
  > = getSettings(),
): DelayLevel {
  if (
    latencyMs >= v['dataDelays.criticalMs'] ||
    sinceLastUpdateMs >= v['dataDelays.criticalLastUpdateSec'] * 1000
  )
    return 'critical';
  if (latencyMs >= v['dataDelays.warningMs']) return 'warning';
  return 'ok';
}

// ------------------------------------------------------------------ persistence (per profile)

export const STORAGE_KEY = 'settings';

interface StoredSettings {
  version: 1;
  values: Partial<SettingsValues>;
}

let syncInstalled = false;

/**
 * Loads the logged-in user's settings after every login / unlock and saves changes (debounced).
 * Idempotent; called by the Settings module at start-up.
 */
export function installSettingsSync(): void {
  if (syncInstalled) return;
  syncInstalled = true;
  let current: string | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    saveTimer = null;
    const st = useSettingsStore.getState();
    if (!st.loaded || st.profileId !== current || !current) return;
    const doc: StoredSettings = { version: 1, values: modifiedValues(st.values, st.defaults) };
    void backend.saveSettings(STORAGE_KEY, doc).catch((e) => console.warn('settings save', e));
  };

  const onSession = (s: SessionInfo | null) => {
    const id = s?.profileId ?? null;
    if (id === current) return;
    if (saveTimer) {
      clearTimeout(saveTimer);
      flush();
    }
    current = id;
    if (!s) {
      useSettingsStore.setState({ loaded: false, profileId: null });
      return;
    }
    const defaults = profileDefaults(s);
    useSettingsStore.setState({ profileId: id, loaded: false, defaults, values: defaults });
    backend
      .loadSettings<StoredSettings>(STORAGE_KEY)
      .then((stored) => {
        if (current !== id) return;
        const r = sanitizeValues(stored?.values ?? {}, defaults);
        if (r.errors.length) console.warn('Some saved settings were invalid', r.errors);
        useSettingsStore.setState({ values: r.values, loaded: true });
      })
      .catch((e) => {
        console.warn('settings load', e);
        if (current === id) useSettingsStore.setState({ loaded: true });
      });
  };

  onSession(useSession.getState().session);
  useSession.subscribe((st) => onSession(st.session));
  useSettingsStore.subscribe((st, prev) => {
    if (!st.loaded || !prev.loaded || st.values === prev.values) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 250);
  });
  if (typeof window !== 'undefined')
    window.addEventListener('beforeunload', () => saveTimer && flush());
}
