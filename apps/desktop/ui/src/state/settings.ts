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
import {
  THEMES,
  sanitizeLayout,
  type ColumnLayout,
  type ThemeName,
  type ThemeTokens,
} from '@htflow/ui-kit';
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
  | 'layout'
  | 'chart'
  | 'footprint'
  | 'heatmap'
  | 'dom'
  | 'tape'
  | 'trading'
  | 'data'
  | 'alerts'
  | 'hotkeys'
  | 'sounds'
  | 'risk'
  | 'privacy'
  | 'timezones'
  | 'commission'
  | 'dataDelays'
  | 'performance'
  | 'logs'
  | 'common'
  | 'modules'
  | 'about';

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
    id: 'layout',
    label: 'Layout',
    description:
      'Window grid, gaps, headers, tabs, where new windows open, link-group colours and multi-monitor restore.',
  },
  {
    id: 'chart',
    label: 'Chart',
    description:
      'Defaults for every chart: mode, candle colours, background, grid, axes, crosshair, legend.',
  },
  {
    id: 'footprint',
    label: 'Footprint',
    description:
      'Cell mode, imbalance rules, POC / value area, rows and fonts of footprint charts.',
  },
  {
    id: 'heatmap',
    label: 'Heatmap',
    description: 'Liquidity-map palette, contrast, trade bubbles and history window.',
  },
  {
    id: 'dom',
    label: 'DOM',
    description: 'Depth-of-market ladder: row size, centring, big-lot highlight and levels.',
  },
  {
    id: 'tape',
    label: 'Tape',
    description: 'Time & sales: rows kept, size filter, big-trade threshold and colouring.',
  },
  {
    id: 'trading',
    label: 'Trading',
    description: 'Default quantity, order type, slippage, brackets, one-click and confirmations.',
  },
  {
    id: 'data',
    label: 'Data',
    description: 'Provider priority, recorder, cache size, history days and reconnects.',
  },
  {
    id: 'alerts',
    label: 'Alerts',
    description:
      'How alerts notify you, default expiry and limits. Sounds live on the Sounds page.',
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
    id: 'risk',
    label: 'Risk',
    description: 'Default risk limits applied to new accounts and the pre-trade checks.',
  },
  {
    id: 'privacy',
    label: 'Privacy & security',
    description: 'Auto-lock, telemetry (always off, local only) and clearing local data.',
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
    id: 'logs',
    label: 'Logs',
    description: 'Log level, retention and where the log files live.',
  },
  {
    id: 'common',
    label: 'Common settings',
    description: 'Applies to the whole app and every window.',
  },
  {
    id: 'modules',
    label: 'Custom modules',
    description: 'Installed modules with enable / disable, and folders to load modules from.',
  },
  {
    id: 'about',
    label: 'About & updates',
    description: 'Version, open-source licences, links and update preferences.',
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
  /** True when a change only takes effect after HT Flow restarts (a visible note is shown). */
  restartRequired?: boolean;
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
/** "" = follow the theme, otherwise #RRGGBB. */
export interface ColorDef extends BaseDef<string> {
  type: 'color';
}
export interface TimezoneDef extends BaseDef<string> {
  type: 'timezone';
  /** Non-IANA values accepted besides IANA zones (e.g. "app", "exchange"). */
  special?: EnumOption[];
}
export interface CustomDef<T> extends BaseDef<T> {
  type: 'custom';
  /** Which editor renders it (tokens, bindings, sounds, rules, clocks). */
  editor:
    | 'tokens'
    | 'hotkeys'
    | 'soundEvents'
    | 'customSounds'
    | 'commissionRules'
    | 'clocks'
    | 'providers'
    | 'dataSources'
    | 'moduleToggles'
    | 'moduleFolders'
    | 'tableLayouts';
  /** Returns the cleaned value, or undefined when invalid. */
  validate(v: unknown): T | undefined;
}

export type SettingDef =
  | NumberDef
  | BooleanDef
  | EnumDef
  | StringDef
  | ColorDef
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
const color = (d: Omit<ColorDef, 'type' | 'default'>): ColorDef => ({
  type: 'color',
  default: '',
  ...d,
});
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

/** Column order / widths of every table that has a table id (ui-kit Table). */
function validateTableLayouts(v: unknown): Record<string, ColumnLayout> | undefined {
  if (!isObj(v)) return undefined;
  const entries = Object.entries(v);
  if (entries.length > 100) return undefined;
  const out: Record<string, ColumnLayout> = {};
  for (const [id, raw] of entries) {
    if (!/^[a-z0-9._-]{1,64}$/i.test(id) || !isObj(raw)) return undefined;
    const l = sanitizeLayout(raw);
    if (l.order.length || Object.keys(l.widths).length) out[id] = l;
  }
  return out;
}

const KNOWN_PROVIDERS = [
  'binance-futures',
  'binance-spot',
  'binance-coinm',
  'bybit-linear',
  'okx-swap',
  'bitget',
  'deribit',
  'kraken-futures',
  'bitfinex',
  'phemex',
  'whitebit',
  'replay',
  'mock',
];

function validateIdList(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || v.length > 200) return undefined;
  if (!v.every((x) => typeof x === 'string' && /^[a-z0-9._-]{1,64}$/i.test(x))) return undefined;
  return [...new Set(v as string[])];
}

/** Provider ids, first = highest priority; every known provider stays in the list. */
function validateProviders(v: unknown): string[] | undefined {
  const ids = validateIdList(v);
  if (!ids || ids.length > 20) return undefined;
  return [...ids, ...KNOWN_PROVIDERS.filter((p) => !ids.includes(p))];
}

function validateFolders(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || v.length > 20) return undefined;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string') return undefined;
    const s = x.trim();
    if (!s || s.length > 260 || /[<>"|?*\0]/.test(s)) return undefined;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/** Languages written right-to-left: the layout mirrors, charts and numbers never do. */
export const RTL_LANGUAGES: string[] = ['ur', 'ar'];

const LANGUAGES: EnumOption<'en' | 'ur' | 'hi' | 'ar' | 'es' | 'ru' | 'tr' | 'zh'>[] = [
  { value: 'en', label: 'English — 100%' },
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
  'general.rtl': oneOf({
    section: 'general',
    group: 'Language & region',
    label: 'Layout direction (RTL preview)',
    help: 'Automatic follows the language (always left-to-right until Urdu / Arabic ship). "Right to left" previews the mirrored layout now: panels and menus mirror; charts, price ladders and numbers never do.',
    default: 'auto',
    options: [
      { value: 'auto', label: 'Automatic (by language)' },
      { value: 'ltr', label: 'Left to right' },
      { value: 'rtl', label: 'Right to left (preview)' },
    ],
    keywords: 'rtl urdu arabic mirror direction dir',
  }),
  'general.numberFormat': oneOf({
    section: 'general',
    group: 'Language & region',
    label: 'Number format',
    help: 'Decimal and thousands separators of numbers in tables and the journal.',
    default: 'en-US',
    options: [
      { value: 'en-US', label: '1,234.56' },
      { value: 'de-DE', label: '1.234,56' },
      { value: 'fr-FR', label: '1 234,56' },
      { value: 'en-IN', label: '1,23,456.78' },
    ],
    keywords: 'decimal separator thousands locale',
    wired: true,
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
  }),
  'general.confirmOrders': bool({
    section: 'general',
    alsoIn: ['trading'],
    group: 'Confirmations',
    label: 'Confirm before sending orders',
    help: 'Ask before every order from the Trading panel, DOM or chart.',
    default: false,
    wired: true,
  }),
  'general.confirmFlatten': bool({
    section: 'general',
    alsoIn: ['trading'],
    group: 'Confirmations',
    label: 'Confirm Flatten all / Cancel all',
    help: 'Ask before closing every position or cancelling every order.',
    default: true,
  }),
  'general.confirmCloseWindow': bool({
    section: 'general',
    group: 'Confirmations',
    label: 'Confirm before closing a window',
    help: 'Ask before a chart / DOM / module window is closed.',
    default: false,
  }),
  'general.confirmExit': bool({
    section: 'general',
    group: 'Confirmations',
    label: 'Confirm on exit',
    help: 'Ask before HT Flow is closed while positions or orders are open.',
    default: true,
  }),
  'general.autoLockMin': num({
    section: 'general',
    alsoIn: ['privacy'],
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

  'appearance.loginAnimation': bool({
    section: 'appearance',
    group: 'Login screen',
    label: 'Animated login background',
    help: 'Show the slow footprint-candle animation behind the login card. It pauses when the window is hidden and is replaced by a still picture when the system asks for reduced motion.',
    default: true,
    keywords: 'animation motion background canvas footprint login',
    wired: true,
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
    alsoIn: ['alerts'],
    group: 'Master',
    label: 'Mute all sounds',
    help: 'Silence every sound without changing the per-event settings.',
    default: false,
    keywords: 'silent audio',
  }),
  'sounds.master': num({
    section: 'sounds',
    alsoIn: ['alerts'],
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
    wired: true,
  }),
  'timezones.calendar': tz({
    section: 'timezones',
    alsoIn: ['general'],
    group: 'Zones',
    label: 'Calendar time zone',
    help: 'Time zone of the economic calendar and news (P39).',
    default: 'app',
    special: [ZONE_SPECIAL[0]!],
    wired: true,
  }),
  'timezones.exchangeTimeOnHover': bool({
    section: 'timezones',
    group: 'Exchange clocks',
    label: 'Exchange time on hover',
    help: 'Show the exchange local time in tooltips over times (charts, tables).',
    default: true,
    wired: true,
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
    wired: true,
  }),
  'performance.videoAdapter': oneOf({
    section: 'performance',
    alsoIn: ['common'],
    group: 'Rendering',
    label: 'Video adapter',
    help: 'GPU the whole app (WebView2: all charts and WebGL) runs on, on PCs with integrated + discrete graphics. Passed to WebView2 at start-up, so it applies after a restart. The 3D heatmap also honours it for new WebGL contexts; the Heatmap rendering adapter wins there when set.',
    default: 'auto',
    options: [
      { value: 'auto', label: 'Auto' },
      { value: 'high-performance', label: 'Discrete (high performance)' },
      { value: 'low-power', label: 'Integrated (low power)' },
    ],
    wired: true,
    restartRequired: true,
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
    wired: true,
  }),
  'performance.workerCount': num({
    section: 'performance',
    alsoIn: ['common'],
    group: 'Rendering',
    label: 'Render / worker threads',
    help: 'Web workers that compute chart indicators (max 8 used; applied on next start).',
    default: 2,
    min: 1,
    max: 16,
    step: 1,
  }),
  'performance.indicatorWorkers': bool({
    section: 'performance',
    alsoIn: ['common'],
    group: 'Rendering',
    label: 'Compute indicators in background workers',
    help: 'Indicators without tape / feed inputs (and all user scripts) run off the main thread. Applied on next start.',
    default: true,
    keywords: 'worker thread pool indicator performance stage 8',
  }),

  // ---------------------------------------------------------------- Common settings (board 19)
  'common.vaPercent': num({
    section: 'common',
    alsoIn: ['footprint'],
    group: 'Value Area',
    label: 'Value Area percent',
    help: 'Share of volume inside the value area of every volume profile.',
    default: 70,
    min: 50,
    max: 95,
    step: 1,
    unit: '%',
    wired: true,
  }),
  'common.vaLevelsAtTime': num({
    section: 'common',
    alsoIn: ['footprint'],
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
    alsoIn: ['chart', 'data'],
    group: 'Common',
    label: 'Max candles per chart',
    help: 'Older bars are dropped beyond this count to keep memory bounded.',
    default: 100_000,
    min: 1000,
    max: 1_000_000,
    step: 1000,
    wired: true,
  }),
  'common.autoBackfill': bool({
    section: 'common',
    alsoIn: ['chart', 'data'],
    group: 'Common',
    label: 'Load all available history automatically',
    help: 'Charts show the latest data at once, then load older history in the background as far back as the venue provides (up to Max candles per chart). Scrolling left always loads more.',
    default: true,
    wired: true,
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
    alsoIn: ['heatmap'],
    group: 'Heatmap rendering',
    label: 'Video adapter',
    help: 'GPU used by the heatmap / liquidity map renderer.',
    default: 'auto',
    options: [
      { value: 'auto', label: 'Auto' },
      { value: 'high-performance', label: 'Discrete (high performance)' },
      { value: 'low-power', label: 'Integrated (low power)' },
    ],
    wired: true,
  }),
  'common.heatmapFpsMode': oneOf({
    section: 'common',
    alsoIn: ['heatmap'],
    group: 'Heatmap rendering',
    label: 'FPS cap mode',
    help: 'Auto follows the display; Manual uses the cap below.',
    default: 'auto',
    options: [
      { value: 'auto', label: 'Auto' },
      { value: 'manual', label: 'Manual' },
    ],
    wired: true,
  }),
  'common.heatmapFpsCap': num({
    section: 'common',
    alsoIn: ['heatmap'],
    group: 'Heatmap rendering',
    label: 'Manual FPS cap',
    help: 'Heatmap frames per second when the cap mode is Manual.',
    default: 60,
    min: 5,
    max: 240,
    step: 5,
    unit: 'fps',
    wired: true,
  }),
  'common.heatmapStartupLevels': num({
    section: 'common',
    alsoIn: ['heatmap'],
    group: 'Heatmap rendering',
    label: 'Startup levels (+/−)',
    help: 'Price levels above and below the last price shown when a heatmap opens.',
    default: 60,
    min: 10,
    max: 1000,
    step: 10,
    wired: true,
  }),
  'common.backupDays': num({
    section: 'common',
    alsoIn: ['data'],
    group: 'Database & recorder',
    label: 'Backup period',
    help: 'How often the sealed profile folder is copied into backups\\<timestamp>\\ (checked at start-up and daily).',
    default: 1,
    min: 1,
    max: 30,
    step: 1,
    unit: 'days',
    wired: true,
  }),
  'common.maxBackups': num({
    section: 'common',
    alsoIn: ['data'],
    group: 'Database & recorder',
    label: 'Maximum store backups',
    help: 'Older backups are deleted.',
    default: 10,
    min: 1,
    max: 100,
    step: 1,
    wired: true,
  }),
  'common.recorderMaxGb': num({
    section: 'common',
    alsoIn: ['data'],
    group: 'Database & recorder',
    label: 'Recorder max disk',
    help: 'Disk budget of the tick / depth recorder.',
    default: 50,
    min: 1,
    max: 2000,
    step: 1,
    unit: 'GB',
    wired: true,
  }),
  'common.tickRetentionDays': num({
    section: 'common',
    alsoIn: ['data'],
    group: 'Database & recorder',
    label: 'Tick history retention',
    help: 'Recorded ticks older than this are pruned.',
    default: 90,
    min: 1,
    max: 3650,
    step: 1,
    unit: 'days',
    wired: true,
  }),
  'common.domLevels': num({
    section: 'common',
    alsoIn: ['dom'],
    group: 'Depth of market',
    label: 'Levels count (0 = all)',
    help: 'Book levels kept per side for DOM windows.',
    default: 0,
    min: 0,
    max: 1000,
    step: 1,
  }),
  'common.domHeatmapLevels': num({
    section: 'common',
    alsoIn: ['heatmap', 'dom'],
    group: 'Depth of market',
    label: 'Heatmap levels count (0 = all)',
    help: 'Book levels kept per side for heatmaps.',
    default: 0,
    min: 0,
    max: 1000,
    step: 1,
    wired: true,
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
    alsoIn: ['alerts'],
    group: 'Notifications',
    label: 'Show notification',
    help: 'Show pop-up notifications (fills, alerts, connection changes).',
    default: true,
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
    alsoIn: ['trading'],
    group: 'Trading',
    label: 'Do not show warnings',
    help: 'Hide non-blocking trading warnings (e.g. order far from market).',
    default: false,
    wired: false,
  }),
  'common.skipTableConfirmations': bool({
    section: 'common',
    alsoIn: ['trading'],
    group: 'Trading',
    label: 'Skip confirmations in tables',
    help: 'Cancel / close from the Orders and Positions tables without asking.',
    default: false,
  }),
  'common.tableLayouts': custom<Record<string, ColumnLayout>>({
    section: 'common',
    group: 'Tables',
    label: 'Table column layouts',
    help: 'Column widths and order of each table, saved when you drag a header edge or a header. Reset one table or all of them.',
    default: {},
    editor: 'tableLayouts',
    validate: validateTableLayouts,
    keywords: 'table column resize reorder width order',
  }),
  'common.crossTrading': bool({
    section: 'common',
    alsoIn: ['trading'],
    group: 'Trading',
    label: 'Enable cross-trading',
    help: 'Allow opposite orders on the same instrument from different accounts.',
    default: false,
    wired: false,
  }),
  'common.bestPricesIndicator': bool({
    section: 'common',
    alsoIn: ['trading'],
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
  }),
  'common.closeDontAskToday': bool({
    section: 'common',
    group: 'Closing modules',
    label: "Don't ask today",
    help: 'Skip close confirmations until midnight.',
    default: false,
    wired: false,
  }),
  // ---------------------------------------------------------------- Chart (P27)
  // Read by the chart code (ui/src/charts, packages/chart-engine). `wired: false` until it does.
  'chart.defaultMode': oneOf({
    section: 'chart',
    group: 'Defaults',
    label: 'Default chart mode',
    help: 'Price representation of newly opened charts.',
    default: 'candles',
    options: [
      { value: 'candles', label: 'Candlesticks' },
      { value: 'hollow', label: 'Hollow candles' },
      { value: 'bars', label: 'OHLC bars' },
      { value: 'heikin-ashi', label: 'Heikin-Ashi' },
      { value: 'line', label: 'Line' },
      { value: 'area', label: 'Area' },
    ],
    keywords: 'candlestick bars heikin line area style',
    wired: true,
  }),
  'chart.defaultTimeframe': oneOf({
    section: 'chart',
    group: 'Defaults',
    label: 'Default timeframe',
    help: 'Timeframe of newly opened time-based charts.',
    default: '5m',
    options: ['15s', '30s', '1m', '2m', '5m', '15m', '30m', '1h', '4h', '1d'].map((v) => ({
      value: v,
      label: v,
    })),
    wired: true,
  }),
  'chart.autoScroll': bool({
    section: 'chart',
    group: 'Defaults',
    label: 'Auto-scroll to the latest bar',
    help: 'Keep the newest bar in view while the chart is not panned away.',
    default: true,
    wired: true,
  }),
  'chart.barSpacing': num({
    section: 'chart',
    group: 'Defaults',
    label: 'Bar spacing',
    help: 'Initial width of one bar, in pixels.',
    default: 10,
    min: 2,
    max: 80,
    step: 1,
    unit: 'px',
    wired: true,
  }),
  'chart.rightMarginBars': num({
    section: 'chart',
    group: 'Defaults',
    label: 'Right margin',
    help: 'Empty bars kept free on the right of the latest bar.',
    default: 8,
    min: 0,
    max: 100,
    step: 1,
    unit: 'bars',
    wired: true,
  }),
  'chart.candleUp': color({
    section: 'chart',
    group: 'Candle colours',
    label: 'Up candle body',
    help: 'Body colour of rising candles. Empty follows the theme "up" colour.',
    keywords: 'colour color bullish green',
    wired: true,
  }),
  'chart.candleDown': color({
    section: 'chart',
    group: 'Candle colours',
    label: 'Down candle body',
    help: 'Body colour of falling candles. Empty follows the theme "down" colour.',
    keywords: 'colour color bearish red',
    wired: true,
  }),
  'chart.wickUp': color({
    section: 'chart',
    group: 'Candle colours',
    label: 'Up wick',
    help: 'Wick colour of rising candles. Empty follows the body colour.',
    wired: true,
  }),
  'chart.wickDown': color({
    section: 'chart',
    group: 'Candle colours',
    label: 'Down wick',
    help: 'Wick colour of falling candles. Empty follows the body colour.',
    wired: true,
  }),
  'chart.borderUp': color({
    section: 'chart',
    group: 'Candle colours',
    label: 'Up border',
    help: 'Border colour of rising candles. Empty follows the body colour.',
    wired: true,
  }),
  'chart.borderDown': color({
    section: 'chart',
    group: 'Candle colours',
    label: 'Down border',
    help: 'Border colour of falling candles. Empty follows the body colour.',
    wired: true,
  }),
  'chart.bgMode': oneOf({
    section: 'chart',
    group: 'Background',
    label: 'Background',
    help: 'Solid colour or a vertical gradient behind the price pane.',
    default: 'solid',
    options: [
      { value: 'solid', label: 'Solid' },
      { value: 'gradient', label: 'Gradient' },
    ],
    wired: true,
  }),
  'chart.bgColor': color({
    section: 'chart',
    group: 'Background',
    label: 'Background colour',
    help: 'Solid background. Empty follows the theme chart background.',
    wired: true,
  }),
  'chart.bgGradientTop': color({
    section: 'chart',
    group: 'Background',
    label: 'Gradient top',
    help: 'Top colour when the background is a gradient.',
    wired: true,
  }),
  'chart.bgGradientBottom': color({
    section: 'chart',
    group: 'Background',
    label: 'Gradient bottom',
    help: 'Bottom colour when the background is a gradient.',
    wired: true,
  }),
  'chart.gridVisible': bool({
    section: 'chart',
    group: 'Grid',
    label: 'Show grid',
    help: 'Draw the horizontal and vertical grid lines.',
    default: true,
    wired: true,
  }),
  'chart.gridStyle': oneOf({
    section: 'chart',
    group: 'Grid',
    label: 'Grid style',
    help: 'Line style of the grid.',
    default: 'solid',
    options: [
      { value: 'solid', label: 'Solid' },
      { value: 'dashed', label: 'Dashed' },
      { value: 'dotted', label: 'Dotted' },
    ],
    wired: true,
  }),
  'chart.gridColor': color({
    section: 'chart',
    group: 'Grid',
    label: 'Grid colour',
    help: 'Empty follows the theme divider colour.',
    wired: true,
  }),
  'chart.gridOpacity': num({
    section: 'chart',
    group: 'Grid',
    label: 'Grid opacity',
    help: 'Opacity of the grid lines.',
    default: 40,
    min: 0,
    max: 100,
    step: 5,
    unit: '%',
    wired: true,
  }),
  'chart.axisSide': oneOf({
    section: 'chart',
    group: 'Axes & scales',
    label: 'Price axis side',
    help: 'Which side of the chart carries the price scale.',
    default: 'right',
    options: [
      { value: 'right', label: 'Right' },
      { value: 'left', label: 'Left' },
    ],
    wired: true,
  }),
  'chart.priceScaleMode': oneOf({
    section: 'chart',
    group: 'Axes & scales',
    label: 'Price scale',
    help: 'Scale type of the price axis.',
    default: 'normal',
    options: [
      { value: 'normal', label: 'Normal' },
      { value: 'log', label: 'Logarithmic' },
      { value: 'percent', label: 'Percentage' },
    ],
    wired: true,
  }),
  'chart.autoScale': bool({
    section: 'chart',
    group: 'Axes & scales',
    label: 'Auto-scale price axis',
    help: 'Fit the price axis to the visible bars.',
    default: true,
    wired: true,
  }),
  'chart.scaleMarginPct': num({
    section: 'chart',
    group: 'Axes & scales',
    label: 'Scale margins (top / bottom)',
    help: 'Free space above and below the visible price range when auto-scaling.',
    default: 8,
    min: 0,
    max: 40,
    step: 1,
    unit: '%',
    wired: true,
  }),
  'chart.lastPriceLine': bool({
    section: 'chart',
    group: 'Axes & scales',
    label: 'Last price line and label',
    help: 'Draw a line and an axis label at the last traded price.',
    default: true,
    wired: true,
  }),
  'chart.sessionBreaks': bool({
    section: 'chart',
    group: 'Axes & scales',
    label: 'Session separators',
    help: 'Draw a vertical line where a trading session starts.',
    default: true,
    wired: true,
  }),
  'chart.crosshairStyle': oneOf({
    section: 'chart',
    group: 'Crosshair',
    label: 'Crosshair style',
    help: 'Shape of the crosshair that follows the pointer.',
    default: 'dashed',
    options: [
      { value: 'full', label: 'Full lines' },
      { value: 'dashed', label: 'Dashed lines' },
      { value: 'dotted', label: 'Dotted lines' },
      { value: 'dot', label: 'Dot only' },
    ],
    wired: true,
  }),
  'chart.crosshairColor': color({
    section: 'chart',
    group: 'Crosshair',
    label: 'Crosshair colour',
    help: 'Empty follows the theme text colour.',
    wired: true,
  }),
  'chart.crosshairLabels': bool({
    section: 'chart',
    group: 'Crosshair',
    label: 'Axis labels at the crosshair',
    help: 'Show the price and time under the pointer on the axes.',
    default: true,
    wired: true,
  }),
  'chart.magnet': oneOf({
    section: 'chart',
    group: 'Crosshair',
    label: 'Magnet to OHLC',
    help: 'Snap the crosshair and drawing anchors to the nearest open / high / low / close.',
    default: 'off',
    options: [
      { value: 'off', label: 'Off' },
      { value: 'weak', label: 'Weak' },
      { value: 'strong', label: 'Strong' },
    ],
    wired: true,
  }),
  'chart.legend': bool({
    section: 'chart',
    group: 'Legend & status line',
    label: 'Show legend',
    help: 'Symbol, timeframe and OHLC values in the top-left corner.',
    default: true,
    wired: true,
  }),
  'chart.statusLine': bool({
    section: 'chart',
    group: 'Legend & status line',
    label: 'Show status line',
    help: 'Indicator values and data status under the legend.',
    default: true,
    wired: true,
  }),
  'chart.watermark': bool({
    section: 'chart',
    group: 'Legend & status line',
    label: 'Show symbol watermark',
    help: 'Large faint symbol name behind the bars.',
    default: false,
    wired: true,
  }),

  // ---------------------------------------------------------------- Footprint (P27)
  'footprint.cellMode': oneOf({
    section: 'footprint',
    group: 'Cells',
    label: 'Cell content',
    help: 'What each footprint cell shows.',
    default: 'bidAsk',
    options: [
      { value: 'bidAsk', label: 'Bid x Ask' },
      { value: 'delta', label: 'Delta' },
      { value: 'volume', label: 'Volume' },
      { value: 'volumeDelta', label: 'Volume + delta' },
    ],
    wired: true,
  }),
  'footprint.colorMode': oneOf({
    section: 'footprint',
    group: 'Cells',
    label: 'Cell colouring',
    help: 'What the cell background intensity follows.',
    default: 'volume',
    options: [
      { value: 'volume', label: 'Volume' },
      { value: 'delta', label: 'Delta' },
      { value: 'none', label: 'None' },
    ],
    wired: true,
  }),
  'footprint.cellOpacity': num({
    section: 'footprint',
    group: 'Cells',
    label: 'Cell background opacity',
    help: 'Strength of the cell background colouring.',
    default: 100,
    min: 0,
    max: 100,
    step: 5,
    unit: '%',
    wired: true,
  }),
  'footprint.fontSize': num({
    section: 'footprint',
    group: 'Cells',
    label: 'Cell font size',
    help: 'Text size inside footprint cells.',
    default: 11,
    min: 8,
    max: 18,
    step: 1,
    unit: 'px',
    wired: true,
  }),
  'footprint.minCellHeight': num({
    section: 'footprint',
    group: 'Cells',
    label: 'Minimum cell height',
    help: 'Cells are hidden (bars switch to candles) when a price row would be thinner than this.',
    default: 9,
    min: 6,
    max: 40,
    step: 1,
    unit: 'px',
    wired: true,
  }),
  'footprint.imbalanceRatio': num({
    section: 'footprint',
    group: 'Imbalance',
    label: 'Imbalance ratio',
    help: 'A diagonal imbalance is flagged when one side is at least this many percent of the other.',
    default: 300,
    min: 110,
    max: 1000,
    step: 10,
    unit: '%',
    keywords: 'diagonal imbalance ratio',
    wired: true,
  }),
  'footprint.imbalanceMinVolume': num({
    section: 'footprint',
    group: 'Imbalance',
    label: 'Imbalance minimum volume',
    help: 'Ignore imbalances where the larger side is below this volume.',
    default: 0,
    min: 0,
    max: 100_000,
    step: 1,
    wired: true,
  }),
  'footprint.stackedImbalance': num({
    section: 'footprint',
    group: 'Imbalance',
    label: 'Stacked imbalance levels',
    help: 'Consecutive imbalanced levels needed to draw a stacked-imbalance marker.',
    default: 3,
    min: 2,
    max: 10,
    step: 1,
    wired: true,
  }),
  'footprint.imbalanceBuyColor': color({
    section: 'footprint',
    group: 'Imbalance',
    label: 'Buy imbalance colour',
    help: 'Empty follows the theme "up" colour.',
    wired: true,
  }),
  'footprint.imbalanceSellColor': color({
    section: 'footprint',
    group: 'Imbalance',
    label: 'Sell imbalance colour',
    help: 'Empty follows the theme "down" colour.',
    wired: true,
  }),
  'footprint.showPoc': bool({
    section: 'footprint',
    group: 'Profile marks',
    label: 'Mark the point of control',
    help: 'Highlight the highest-volume price of every bar.',
    default: true,
    wired: true,
  }),
  'footprint.pocColor': color({
    section: 'footprint',
    group: 'Profile marks',
    label: 'POC colour',
    help: 'Empty follows the theme warning colour.',
    wired: true,
  }),
  'footprint.showValueArea': bool({
    section: 'footprint',
    group: 'Profile marks',
    label: 'Mark the value area',
    help: 'Outline the value area of every bar (percentage under Common settings).',
    default: false,
    wired: true,
  }),
  'footprint.absorptionMarkers': bool({
    section: 'footprint',
    group: 'Profile marks',
    label: 'Absorption markers',
    help: 'Mark levels with large volume and no price progress.',
    default: false,
    wired: true,
  }),
  'footprint.showDeltaRow': bool({
    section: 'footprint',
    group: 'Summary rows',
    label: 'Delta row',
    help: 'Show the bar delta under every footprint bar.',
    default: true,
    wired: true,
  }),
  'footprint.showVolumeRow': bool({
    section: 'footprint',
    group: 'Summary rows',
    label: 'Volume row',
    help: 'Show the bar volume under every footprint bar.',
    default: true,
    wired: true,
  }),
  'footprint.showCumDelta': bool({
    section: 'footprint',
    group: 'Summary rows',
    label: 'Cumulative delta row',
    help: 'Show the session cumulative delta under every footprint bar.',
    default: false,
    wired: true,
  }),

  // ---------------------------------------------------------------- Heatmap (P27)
  'heatmap.palette': oneOf({
    section: 'heatmap',
    group: 'Colours',
    label: 'Colour palette',
    help: 'Colour ramp of resting liquidity.',
    default: 'thermal',
    options: [
      { value: 'thermal', label: 'Thermal' },
      { value: 'mono', label: 'Monochrome' },
      { value: 'blue-red', label: 'Blue to red' },
      { value: 'viridis', label: 'Viridis' },
    ],
    wired: true,
  }),
  'heatmap.contrast': num({
    section: 'heatmap',
    group: 'Colours',
    label: 'Contrast',
    help: 'Stretches the ramp so small resting orders stand out.',
    default: 50,
    min: 0,
    max: 100,
    step: 5,
    unit: '%',
    wired: true,
  }),
  'heatmap.opacity': num({
    section: 'heatmap',
    group: 'Colours',
    label: 'Opacity',
    help: 'Opacity of the liquidity layer over the chart background.',
    default: 100,
    min: 10,
    max: 100,
    step: 5,
    unit: '%',
    wired: true,
  }),
  'heatmap.normalization': oneOf({
    section: 'heatmap',
    group: 'Scaling',
    label: 'Normalisation',
    help: 'Whether colour intensity is scaled to the visible window or the whole session.',
    default: 'visible',
    options: [
      { value: 'visible', label: 'Visible window' },
      { value: 'session', label: 'Whole session' },
    ],
    wired: true,
  }),
  'heatmap.minSize': num({
    section: 'heatmap',
    group: 'Scaling',
    label: 'Minimum order size',
    help: 'Resting orders smaller than this are not drawn. 0 = draw everything.',
    default: 0,
    min: 0,
    max: 1_000_000,
    step: 1,
    wired: true,
  }),
  'heatmap.smoothing': bool({
    section: 'heatmap',
    group: 'Scaling',
    label: 'Smooth between snapshots',
    help: 'Interpolate colours between depth snapshots instead of drawing hard steps.',
    default: false,
    wired: true,
  }),
  'heatmap.historyMinutes': num({
    section: 'heatmap',
    group: 'History',
    label: 'Depth history',
    help: 'Minutes of order-book history kept for the heatmap.',
    default: 60,
    min: 5,
    max: 1440,
    step: 5,
    unit: 'min',
    wired: true,
  }),
  'heatmap.showBestBidAsk': bool({
    section: 'heatmap',
    group: 'Overlays',
    label: 'Best bid / ask lines',
    help: 'Draw the best bid and best ask over the heatmap.',
    default: true,
    wired: true,
  }),
  'heatmap.showTradeBubbles': bool({
    section: 'heatmap',
    group: 'Overlays',
    label: 'Trade bubbles',
    help: 'Draw executed trades as bubbles sized by volume.',
    default: true,
    wired: true,
  }),
  'heatmap.bubbleScale': num({
    section: 'heatmap',
    group: 'Overlays',
    label: 'Bubble size',
    help: 'Scales the radius of trade bubbles.',
    default: 100,
    min: 25,
    max: 400,
    step: 5,
    unit: '%',
    wired: true,
  }),
  'heatmap.bubbleMinSize': num({
    section: 'heatmap',
    group: 'Overlays',
    label: 'Smallest bubble',
    help: 'Trades below this volume get no bubble.',
    default: 1,
    min: 0,
    max: 1_000_000,
    step: 1,
    wired: true,
  }),
  'heatmap.showVolumeProfile': bool({
    section: 'heatmap',
    group: 'Overlays',
    label: 'Volume profile on the right',
    help: 'Show the visible-range volume profile next to the price axis.',
    default: true,
    wired: true,
  }),

  // ---------------------------------------------------------------- DOM (P27)
  'dom.rowHeight': num({
    section: 'dom',
    group: 'Ladder',
    label: 'Row height',
    help: 'Height of one price row in the DOM ladder.',
    default: 22,
    min: 14,
    max: 40,
    step: 1,
    unit: 'px',
  }),
  'dom.fontSize': num({
    section: 'dom',
    group: 'Ladder',
    label: 'Font size',
    help: 'Text size of the ladder.',
    default: 12,
    min: 9,
    max: 18,
    step: 1,
    unit: 'px',
    wired: true,
  }),
  'dom.autoCenter': bool({
    section: 'dom',
    group: 'Ladder',
    label: 'Auto-centre on price',
    help: 'Re-centre the ladder when the price leaves the middle band. Off keeps your scroll position.',
    default: true,
  }),
  'dom.defaultGrouping': oneOf({
    section: 'dom',
    group: 'Ladder',
    label: 'Default price grouping',
    help: 'Ticks per row of a newly opened DOM.',
    default: '1',
    options: ['1', '2', '5', '10', '20', '50'].map((v) => ({ value: v, label: `${v} tick` })),
    wired: true,
  }),
  'dom.bigLotThreshold': num({
    section: 'dom',
    group: 'Highlights',
    label: 'Big-lot threshold',
    help: 'Book sizes at or above this are highlighted. 0 = off.',
    default: 0,
    min: 0,
    max: 1_000_000,
    step: 1,
  }),
  'dom.recentWindowSec': num({
    section: 'dom',
    group: 'Highlights',
    label: 'Recent buys / sells window',
    help: 'Seconds of trades summed in the Buys / Sells columns.',
    default: 30,
    min: 1,
    max: 600,
    step: 1,
    unit: 's',
    wired: true,
  }),
  'dom.invertClicks': bool({
    section: 'dom',
    group: 'Clicking',
    label: 'Swap left / right click',
    help: 'Left click sells and right click buys (default: left buys, right sells).',
    default: false,
    wired: true,
  }),

  // ---------------------------------------------------------------- Tape (P27)
  'tape.maxRows': num({
    section: 'tape',
    group: 'Rows',
    label: 'Rows kept',
    help: 'Trades kept in the tape before the oldest are dropped.',
    default: 5000,
    min: 100,
    max: 100_000,
    step: 100,
    wired: true,
  }),
  'tape.minSize': num({
    section: 'tape',
    group: 'Rows',
    label: 'Minimum trade size',
    help: 'Hide trades smaller than this. 0 = show all.',
    default: 0,
    min: 0,
    max: 1_000_000,
    step: 1,
    wired: true,
  }),
  'tape.autoScroll': bool({
    section: 'tape',
    group: 'Rows',
    label: 'Follow new trades',
    help: 'Keep the newest trade in view.',
    default: true,
    wired: true,
  }),
  'tape.showMs': bool({
    section: 'tape',
    group: 'Time',
    label: 'Show milliseconds',
    help: 'Show .mmm after the seconds of every trade time.',
    default: true,
  }),
  'tape.bigTradeThreshold': num({
    section: 'tape',
    group: 'Highlights',
    label: 'Big-trade threshold',
    help: 'Trades at or above this size are highlighted and can sound. 0 = automatic.',
    default: 0,
    min: 0,
    max: 1_000_000,
    step: 1,
    wired: true,
  }),
  'tape.colorBySide': bool({
    section: 'tape',
    group: 'Highlights',
    label: 'Colour by aggressor side',
    help: 'Green for buyer-initiated, red for seller-initiated trades.',
    default: true,
    wired: true,
  }),
  'tape.beepOnBig': bool({
    section: 'tape',
    group: 'Highlights',
    label: 'Beep on big trades',
    help: 'Play the "big trade" sound for trades above the threshold.',
    default: false,
    wired: true,
  }),

  // ---------------------------------------------------------------- Trading (P27)
  // Read by the trading panel, DOM and chart trading (ui/src/trading, packages/trading).
  'trading.defaultQty': num({
    section: 'trading',
    group: 'Orders',
    label: 'Default quantity',
    help: 'Quantity prefilled in the Trading panel and DOM.',
    default: 1,
    min: 0.0001,
    max: 1_000_000,
    step: 0.0001,
    wired: true,
  }),
  'trading.qtyPresets': str({
    section: 'trading',
    group: 'Orders',
    label: 'Quantity presets',
    help: 'Comma-separated quantities for the quick-size buttons, e.g. 1,2,5,10.',
    default: '1,2,5,10',
    maxLength: 80,
    pattern: /^\d+(\.\d+)?(,\d+(\.\d+)?){0,11}$/,
    patternHint: 'Up to 12 positive numbers separated by commas, e.g. 1,2,5,10',
    wired: true,
  }),
  'trading.defaultOrderType': oneOf({
    section: 'trading',
    group: 'Orders',
    label: 'Default order type',
    help: 'Order type preselected in the Trading panel.',
    default: 'limit',
    options: [
      { value: 'market', label: 'Market' },
      { value: 'limit', label: 'Limit' },
      { value: 'stop', label: 'Stop' },
    ],
    wired: true,
  }),
  'trading.defaultTif': oneOf({
    section: 'trading',
    group: 'Orders',
    label: 'Time in force',
    help: 'How long new orders stay working.',
    default: 'gtc',
    options: [
      { value: 'gtc', label: 'Good till cancelled' },
      { value: 'day', label: 'Day' },
      { value: 'ioc', label: 'Immediate or cancel' },
      { value: 'fok', label: 'Fill or kill' },
    ],
    wired: true,
  }),
  'trading.oneClick': bool({
    section: 'trading',
    group: 'Orders',
    label: 'One-click trading',
    help: 'Clicking the DOM or chart sends the order immediately.',
    default: true,
    keywords: 'dom click',
    wired: true,
  }),
  'trading.orderHotkeys': bool({
    section: 'trading',
    group: 'Orders',
    label: 'Order hot keys enabled',
    help: 'Allow the buy / sell / flatten hot keys. Bindings are on the Hot keys page.',
    default: true,
    wired: true,
  }),
  'trading.slippageTicks': num({
    section: 'trading',
    group: 'Protection',
    label: 'Slippage tolerance',
    help: 'Market orders are rejected when the fill would be worse than this many ticks from the quote.',
    default: 5,
    min: 0,
    max: 1000,
    step: 1,
    unit: 'ticks',
    wired: true,
  }),
  'trading.autoBracket': bool({
    section: 'trading',
    group: 'Brackets',
    label: 'Attach stop and target automatically',
    help: 'Every entry gets an OCO stop-loss and take-profit with the distances below.',
    default: false,
    wired: true,
  }),
  'trading.stopTicks': num({
    section: 'trading',
    group: 'Brackets',
    label: 'Default stop distance',
    help: 'Stop-loss distance from the entry price.',
    default: 20,
    min: 1,
    max: 10_000,
    step: 1,
    unit: 'ticks',
    wired: true,
  }),
  'trading.targetTicks': num({
    section: 'trading',
    group: 'Brackets',
    label: 'Default target distance',
    help: 'Take-profit distance from the entry price.',
    default: 40,
    min: 1,
    max: 10_000,
    step: 1,
    unit: 'ticks',
    wired: true,
  }),
  'trading.showOrderLines': bool({
    section: 'trading',
    group: 'On chart',
    label: 'Order lines on charts',
    help: 'Draw working orders as horizontal lines you can drag.',
    default: true,
    wired: true,
  }),
  'trading.showPositionLine': bool({
    section: 'trading',
    group: 'On chart',
    label: 'Position line on charts',
    help: 'Draw the average entry price and open P&L of the position.',
    default: true,
    wired: true,
  }),

  // ---------------------------------------------------------------- Data (P27)
  'data.providerPriority': custom<string[]>({
    section: 'data',
    group: 'Providers',
    label: 'Provider priority',
    help: 'When an instrument is offered by several providers, the first one in this list that is connected wins.',
    default: [...KNOWN_PROVIDERS],
    editor: 'providers',
    validate: validateProviders,
    keywords: 'connector feed source order priority',
    wired: true,
  }),
  'data.newsSources': custom<boolean>({
    section: 'data',
    group: 'Data sources',
    label: 'News, RSS and calendar sources',
    help: 'Public, key-free sources fetched by the HT Flow core: the weekly economic calendar and the default RSS feeds. Toggle the calendar here; manage feeds in the RSS Reader.',
    default: true,
    editor: 'dataSources',
    validate: (v) => (typeof v === 'boolean' ? v : undefined),
    keywords: 'news rss calendar economic source feed public data',
    wired: true,
  }),
  'data.autoReconnect': bool({
    section: 'data',
    group: 'Connections',
    label: 'Reconnect automatically',
    help: 'Reconnect a dropped live feed with back-off.',
    default: true,
    wired: true,
  }),
  'data.reconnectMaxSec': num({
    section: 'data',
    group: 'Connections',
    label: 'Longest reconnect wait',
    help: 'Upper bound of the exponential back-off between reconnect attempts.',
    default: 30,
    min: 1,
    max: 600,
    step: 1,
    unit: 's',
    wired: true,
  }),
  'data.cotReport': oneOf({
    section: 'data',
    group: 'Commitments of Traders',
    label: 'Default COT report',
    help: 'Report the COT Chart opens with when the market has it (financials: TFF, commodities: Disaggregated; Legacy is available for all).',
    default: 'tff',
    options: [
      { value: 'tff', label: 'TFF (financial futures)' },
      { value: 'disagg', label: 'Disaggregated (commodities)' },
      { value: 'legacy', label: 'Legacy' },
    ],
    keywords: 'cot cftc commitments traders report',
    wired: true,
  }),
  'data.cotAutoRefresh': bool({
    section: 'data',
    group: 'Commitments of Traders',
    label: 'Refresh COT data weekly',
    help: 'Download new COT data after the Friday release when a COT Chart is open. Off: only the cache (or the Refresh COT data command) is used. Data comes from the free CFTC public reporting API.',
    default: true,
    keywords: 'cot cftc commitments traders refresh update weekly',
    wired: true,
  }),
  'data.timestampSource': oneOf({
    section: 'data',
    group: 'Connections',
    label: 'Timestamp source',
    help: 'Use exchange timestamps, or the local receive time (more consistent across venues).',
    default: 'exchange',
    options: [
      { value: 'exchange', label: 'Exchange time' },
      { value: 'local', label: 'Local receive time' },
    ],
    wired: true,
  }),
  'data.conflateMs': num({
    section: 'data',
    group: 'Connections',
    label: 'Depth conflation',
    help: 'Merge order-book updates arriving within this window. 0 = every update.',
    default: 0,
    min: 0,
    max: 1000,
    step: 10,
    unit: 'ms',
    wired: true,
  }),
  'data.recorderEnabled': bool({
    section: 'data',
    group: 'Recorder & cache',
    label: 'Record live ticks and depth',
    help: 'Write live data to the local tick store so it can be replayed. Disk budget and retention are under Common settings.',
    default: false,
    wired: true,
  }),
  'data.cacheSizeMb': num({
    section: 'data',
    group: 'Recorder & cache',
    label: 'Cache size',
    help: 'Disk space for downloaded history (ticks and bars, desktop app). The least recently used files go first when it is full.',
    default: 512,
    min: 64,
    max: 65_536,
    step: 64,
    unit: 'MB',
    wired: true,
  }),

  // ---------------------------------------------------------------- Alerts (P27)
  'alerts.enabled': bool({
    section: 'alerts',
    group: 'Delivery',
    label: 'Alerts enabled',
    help: 'Master switch. Off keeps your alerts but stops them from triggering.',
    default: true,
  }),
  'alerts.toast': bool({
    section: 'alerts',
    group: 'Delivery',
    label: 'Pop-up notification',
    help: 'Show a notification when an alert triggers.',
    default: true,
  }),
  'alerts.flashTitle': bool({
    section: 'alerts',
    group: 'Delivery',
    label: 'Flash the window title',
    help: 'Flash the title bar when an alert triggers while HT Flow is in the background.',
    default: false,
  }),
  'alerts.defaultRepeat': oneOf({
    section: 'alerts',
    group: 'New alerts',
    label: 'Default repeat',
    help: 'How often a new alert may trigger.',
    default: 'once',
    options: [
      { value: 'once', label: 'Only once' },
      { value: 'every', label: 'Every time' },
      { value: 'bar', label: 'Once per bar' },
    ],
  }),
  'alerts.defaultExpiryDays': num({
    section: 'alerts',
    group: 'New alerts',
    label: 'Default expiry',
    help: 'New alerts expire after this many days. 0 = never.',
    default: 0,
    min: 0,
    max: 365,
    step: 1,
    unit: 'days',
  }),
  'alerts.cooldownSec': num({
    section: 'alerts',
    group: 'New alerts',
    label: 'Cool-down',
    help: 'Minimum seconds between two triggers of the same repeating alert.',
    default: 10,
    min: 0,
    max: 86_400,
    step: 1,
    unit: 's',
  }),
  'alerts.maxActive': num({
    section: 'alerts',
    group: 'Limits',
    label: 'Maximum active alerts',
    help: 'Creating more alerts than this is refused.',
    default: 200,
    min: 1,
    max: 5000,
    step: 1,
  }),

  // ---------------------------------------------------------------- Risk (P27)
  // Defaults for the Risk module (modules/risk) and the paper engine pre-trade checks.
  'risk.maxDailyLoss': num({
    section: 'risk',
    group: 'Limits',
    label: 'Max daily loss',
    help: 'Account currency. Reaching it triggers the breach action. 0 = off.',
    default: 0,
    min: 0,
    max: 100_000_000,
    step: 10,
    unit: 'USD',
    wired: true,
  }),
  'risk.maxPositionSize': num({
    section: 'risk',
    group: 'Limits',
    label: 'Max position size',
    help: 'Largest net position per instrument. 0 = off.',
    default: 0,
    min: 0,
    max: 10_000_000,
    step: 1,
    wired: true,
  }),
  'risk.maxOrderSize': num({
    section: 'risk',
    group: 'Limits',
    label: 'Max order size',
    help: 'Orders larger than this are rejected before they are sent. 0 = off.',
    default: 0,
    min: 0,
    max: 10_000_000,
    step: 1,
    wired: true,
  }),
  'risk.maxTradesPerDay': num({
    section: 'risk',
    group: 'Limits',
    label: 'Max trades per day',
    help: 'Number of round trips allowed per day. 0 = off.',
    default: 0,
    min: 0,
    max: 10_000,
    step: 1,
    wired: true,
  }),
  'risk.priceCollarTicks': num({
    section: 'risk',
    group: 'Limits',
    label: 'Price collar',
    help: 'Limit orders further than this from the market are rejected as fat-finger. 0 = off.',
    default: 0,
    min: 0,
    max: 100_000,
    step: 1,
    unit: 'ticks',
    wired: true,
  }),
  'risk.warnAtPct': num({
    section: 'risk',
    group: 'Breach handling',
    label: 'Warn at',
    help: 'Raise a warning when a limit is this far used.',
    default: 80,
    min: 10,
    max: 100,
    step: 5,
    unit: '%',
    wired: true,
  }),
  'risk.onBreach': oneOf({
    section: 'risk',
    group: 'Breach handling',
    label: 'On breach',
    help: 'What happens when a hard limit is reached.',
    default: 'block',
    options: [
      { value: 'warn', label: 'Warn only' },
      { value: 'block', label: 'Block new orders' },
      { value: 'flatten', label: 'Flatten and block' },
    ],
    wired: true,
  }),
  'risk.lockUntil': oneOf({
    section: 'risk',
    group: 'Breach handling',
    label: 'Lock duration',
    help: 'How long trading stays locked after a breach.',
    default: 'tomorrow',
    options: [
      { value: 'hour', label: '1 hour' },
      { value: 'tomorrow', label: 'Until tomorrow' },
      { value: 'manual', label: 'Until I unlock' },
    ],
    wired: true,
  }),

  // ---------------------------------------------------------------- Privacy & security
  'privacy.telemetry': oneOf({
    section: 'privacy',
    group: 'Telemetry',
    label: 'Telemetry',
    help: 'HT Flow never sends usage data anywhere. This is fixed off and cannot be switched on.',
    default: 'off',
    options: [
      { value: 'off', label: 'Off — nothing leaves this PC' },
      { value: 'on', label: 'On — not available', disabled: true },
    ],
    keywords: 'analytics tracking usage data',
  }),
  'privacy.crashReports': oneOf({
    section: 'privacy',
    group: 'Telemetry',
    label: 'Crash reports',
    help: 'Crashes are written to the local log folder only. Nothing is uploaded.',
    default: 'local',
    options: [
      { value: 'local', label: 'Save locally only' },
      { value: 'upload', label: 'Upload — not available', disabled: true },
    ],
  }),
  'privacy.maskAccounts': bool({
    section: 'privacy',
    group: 'Display',
    label: 'Mask account numbers',
    help: 'Show only the last four characters of account ids in tables and the journal.',
    default: true,
    wired: true,
  }),
  'privacy.hideBalances': bool({
    section: 'privacy',
    group: 'Display',
    label: 'Hide balances',
    help: 'Replace account balances and P&L totals with dots (streaming / screen sharing).',
    default: false,
    wired: true,
  }),
  'privacy.clearOnLogout': bool({
    section: 'privacy',
    group: 'Local data',
    label: 'Clear caches on log-out',
    help: 'Delete the session and market-data caches whenever you log out. Settings, journal and layouts are kept.',
    default: false,
  }),
  'privacy.aiScreenshot': oneOf({
    section: 'privacy',
    group: 'AI assistant',
    label: 'Send screenshots to AI',
    help: 'When you ask the AI about the screen: ask before each screenshot, send automatically, or never send one. Screenshots show only the HT Flow window and go only to the provider you chose.',
    default: 'ask',
    options: [
      { value: 'ask', label: 'Always ask' },
      { value: 'auto', label: 'Send automatically' },
      { value: 'never', label: 'Never' },
    ],
    keywords: 'ai llm screenshot vision privacy',
    wired: true,
  }),
  'privacy.aiContext': bool({
    section: 'privacy',
    group: 'AI assistant',
    label: 'Send screen context to AI',
    help: 'Attach a text summary of the active symbol, timeframe, prices, positions, P&L and recent order flow to your AI questions.',
    default: true,
    keywords: 'ai llm context privacy',
    wired: true,
  }),
  'privacy.aiTools': bool({
    section: 'privacy',
    group: 'AI assistant',
    label: 'Let chat read market data',
    help: 'In chat mode the AI may call read-only tools (market data, order flow, positions, account). Trading tools are only offered in agent mode.',
    default: true,
    keywords: 'ai llm tools function calling',
    wired: true,
  }),

  // ---------------------------------------------------------------- Logs
  'logs.level': oneOf({
    section: 'logs',
    group: 'Logging',
    label: 'Log level',
    help: 'Messages below this level are not recorded.',
    default: 'info',
    options: [
      { value: 'error', label: 'Errors only' },
      { value: 'warn', label: 'Warnings and errors' },
      { value: 'info', label: 'Info' },
      { value: 'debug', label: 'Debug (verbose)' },
    ],
    keywords: 'verbosity debug trace',
  }),
  'logs.bufferSize': num({
    section: 'logs',
    group: 'Logging',
    label: 'In-memory entries',
    help: 'Most recent log entries kept in memory for the Logs window.',
    default: 2000,
    min: 100,
    max: 100_000,
    step: 100,
  }),
  'logs.keepDays': num({
    section: 'logs',
    group: 'Files',
    label: 'Keep log files',
    help: 'Log files older than this are deleted at start-up.',
    default: 14,
    min: 1,
    max: 365,
    step: 1,
    unit: 'days',
    wired: true,
  }),
  'logs.folder': str({
    section: 'logs',
    group: 'Files',
    label: 'Log folder',
    help: 'Where the daily log files are written (secrets are redacted). Applied on the next start.',
    default: '%APPDATA%\\HTFlow\\logs',
    maxLength: 260,
    pattern: /^[^<>"|?*\0]+$/,
    patternHint: 'A folder path without < > " | ? *',
    wired: true,
    restartRequired: true,
  }),

  // ---------------------------------------------------------------- Layout (P25 / P37)
  'layout.snapToGrid': bool({
    section: 'layout',
    group: 'Grid',
    label: 'Snap windows to grid',
    help: 'Floating windows snap their position and size to the grid when you stop dragging or resizing them.',
    default: true,
    keywords: 'magnet align floating',
  }),
  'layout.gridSize': num({
    section: 'layout',
    group: 'Grid',
    label: 'Grid size',
    help: 'Size of one grid cell used by snapping.',
    default: 8,
    min: 2,
    max: 64,
    step: 1,
    unit: 'px',
  }),
  'layout.gap': num({
    section: 'layout',
    group: 'Grid',
    label: 'Gap between windows',
    help: 'Space between docked windows.',
    default: 4,
    min: 0,
    max: 16,
    step: 1,
    unit: 'px',
    keywords: 'spacing gutter margin',
  }),
  'layout.lock': bool({
    section: 'layout',
    group: 'Grid',
    label: 'Lock layout',
    help: 'Windows can no longer be dragged to another place or dropped onto each other (splitters still resize).',
    default: false,
    keywords: 'freeze pin',
  }),
  'layout.headerDensity': oneOf({
    section: 'layout',
    group: 'Window headers',
    label: 'Header density',
    help: 'Height of every window header: compact (26 px) or normal (32 px).',
    default: 'normal',
    options: [
      { value: 'compact', label: 'Compact' },
      { value: 'normal', label: 'Normal' },
    ],
    keywords: 'title bar size',
  }),
  'layout.headerStyle': oneOf({
    section: 'layout',
    group: 'Window headers',
    label: 'Header style',
    help: 'How window headers look: flat on the window surface, raised (darker band) or outlined (separator line only).',
    default: 'raised',
    options: [
      { value: 'raised', label: 'Raised' },
      { value: 'flat', label: 'Flat' },
      { value: 'outlined', label: 'Outlined' },
    ],
  }),
  'layout.tabPosition': oneOf({
    section: 'layout',
    group: 'Window headers',
    label: 'Layout tabs position',
    help: 'Where the workspace layout tabs (one tab per layout) are shown.',
    default: 'bottom',
    options: [
      { value: 'bottom', label: 'Bottom' },
      { value: 'top', label: 'Top' },
    ],
  }),
  'layout.ribbonHidden': bool({
    section: 'layout',
    group: 'Window headers',
    label: 'Hide the ribbon',
    help: 'Hides the module ribbon to gain space; every module stays available from the Command Palette (Ctrl+K). "Icons only" is in Appearance.',
    default: false,
    keywords: 'toolbar ribbon mode',
  }),
  'layout.openChart': oneOf({
    section: 'layout',
    group: 'New windows',
    label: 'Charts open',
    help: 'Whether a new chart window opens docked in the layout or floating above it.',
    default: 'docked',
    options: [
      { value: 'docked', label: 'Docked' },
      { value: 'floating', label: 'Floating' },
      { value: 'window', label: 'New OS window' },
    ],
  }),
  'layout.openDom': oneOf({
    section: 'layout',
    group: 'New windows',
    label: 'DOM windows open',
    help: 'Whether a new DOM window opens docked or floating.',
    default: 'docked',
    options: [
      { value: 'docked', label: 'Docked' },
      { value: 'floating', label: 'Floating' },
      { value: 'window', label: 'New OS window' },
    ],
  }),
  'layout.openTape': oneOf({
    section: 'layout',
    group: 'New windows',
    label: 'Tape windows open',
    help: 'Whether a new Smart Tape / Bid-Ask Tape window opens docked or floating.',
    default: 'docked',
    options: [
      { value: 'docked', label: 'Docked' },
      { value: 'floating', label: 'Floating' },
      { value: 'window', label: 'New OS window' },
    ],
  }),
  'layout.openModule': oneOf({
    section: 'layout',
    group: 'New windows',
    label: 'Other windows open',
    help: 'Whether every other new window (tables, analytics, settings…) opens docked or floating.',
    default: 'docked',
    options: [
      { value: 'docked', label: 'Docked' },
      { value: 'floating', label: 'Floating' },
      { value: 'window', label: 'New OS window' },
    ],
  }),
  'layout.detachMode': oneOf({
    section: 'layout',
    group: 'New windows',
    label: 'Detach window opens',
    help: 'Where "Detach window" moves a window: its own OS window (drag it to another monitor; the desktop app remembers size, position and monitor per window), or a floating window inside the main window. The browser build always floats.',
    default: 'os',
    options: [
      { value: 'os', label: 'Separate OS window' },
      { value: 'float', label: 'Floating inside the main window' },
    ],
    keywords: 'multi monitor second screen undock pop out tear off',
    wired: true,
  }),
  'layout.dockPlacement': oneOf({
    section: 'layout',
    group: 'New windows',
    label: 'Docked placement',
    help: 'Where a new docked window goes, relative to the active window.',
    default: 'tab',
    options: [
      { value: 'tab', label: 'As a tab of the active window' },
      { value: 'right', label: 'Split right' },
      { value: 'below', label: 'Split down' },
    ],
  }),
  'layout.floatPlacement': oneOf({
    section: 'layout',
    group: 'New windows',
    label: 'Floating placement',
    help: 'Where a new floating window appears.',
    default: 'cascade',
    options: [
      { value: 'cascade', label: 'Cascade' },
      { value: 'center', label: 'Centre' },
      { value: 'top-left', label: 'Top left' },
    ],
  }),
  'layout.newWindowWidth': num({
    section: 'layout',
    group: 'New windows',
    label: 'Default width',
    help: 'Width of a new floating window (also used by Detach).',
    default: 820,
    min: 240,
    max: 4000,
    step: 10,
    unit: 'px',
  }),
  'layout.newWindowHeight': num({
    section: 'layout',
    group: 'New windows',
    label: 'Default height',
    help: 'Height of a new floating window (also used by Detach).',
    default: 520,
    min: 160,
    max: 3000,
    step: 10,
    unit: 'px',
  }),
  'layout.linkRed': color({
    section: 'layout',
    group: 'Link groups',
    label: 'Red group colour',
    help: 'Swatch of the red link group in window headers and the link-group manager. Empty = default.',
    keywords: 'link colour',
  }),
  'layout.linkGreen': color({
    section: 'layout',
    group: 'Link groups',
    label: 'Green group colour',
    help: 'Swatch of the green link group. Empty = default.',
    keywords: 'link colour',
  }),
  'layout.linkBlue': color({
    section: 'layout',
    group: 'Link groups',
    label: 'Blue group colour',
    help: 'Swatch of the blue link group. Empty = default.',
    keywords: 'link colour',
  }),
  'layout.linkYellow': color({
    section: 'layout',
    group: 'Link groups',
    label: 'Yellow group colour',
    help: 'Swatch of the yellow link group. Empty = default.',
    keywords: 'link colour',
  }),
  'layout.linkPurple': color({
    section: 'layout',
    group: 'Link groups',
    label: 'Purple group colour',
    help: 'Swatch of the purple link group. Empty = default.',
    keywords: 'link colour',
  }),
  'layout.restoreMonitors': bool({
    section: 'layout',
    group: 'Multi-monitor',
    label: 'Restore window positions',
    help: 'When a workspace loads, put the main window and floating windows back where they were saved. A window whose monitor is missing moves to the primary monitor, fully visible.',
    default: true,
    keywords: 'screen display second monitor',
  }),
  'layout.restoreMode': oneOf({
    section: 'layout',
    group: 'Multi-monitor',
    label: 'Restore mode',
    help: 'Exact keeps saved positions and sizes (only moved when off-screen); Fit to screens scales them to the current screen and window size.',
    default: 'exact',
    options: [
      { value: 'exact', label: 'Exact' },
      { value: 'fit', label: 'Fit to screens' },
    ],
  }),

  // ---------------------------------------------------------------- Custom modules (P43)
  'modules.disabled': custom<string[]>({
    section: 'modules',
    group: 'Installed modules',
    label: 'Disabled modules',
    help: 'A module switched off here shows a "disabled" placeholder instead of its window (ribbon, command palette and saved workspaces alike). Settings itself cannot be disabled.',
    default: [],
    editor: 'moduleToggles',
    validate: validateIdList,
    keywords: 'plugin extension indicator strategy connector panel enable disable remove',
  }),
  'modules.folders': custom<string[]>({
    section: 'modules',
    group: 'Module folders',
    label: 'Module folders',
    help: 'Extra folders scanned for modules. Loading them (sandboxed) arrives with the native core; the list is stored now.',
    default: [],
    editor: 'moduleFolders',
    validate: validateFolders,
    keywords: 'install from file path directory',
    wired: false,
  }),

  // ---------------------------------------------------------------- About & updates
  'about.checkUpdates': bool({
    section: 'about',
    group: 'Updates',
    label: 'Check for updates',
    help: 'Look for a newer HT Flow release on GitHub at start-up. Off by default (no network call is made until you turn it on). "Check for updates" in the Command Palette always works on demand. Builds without an updater key, and the web build, show "Updates unavailable in this build".',
    default: false,
  }),
  'about.updateChannel': oneOf({
    section: 'about',
    group: 'Updates',
    label: 'Update channel',
    help: 'Which releases the updater offers: Stable (published releases) or Beta (pre-releases, may be less tested).',
    default: 'stable',
    options: [
      { value: 'stable', label: 'Stable' },
      { value: 'beta', label: 'Beta' },
    ],
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
    case 'color': {
      if (raw === '') return ok('');
      const hex = normalizeHex(raw);
      return hex ? ok(hex) : fail('Use #RRGGBB, or leave empty to follow the theme');
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

/**
 * Resolves once the logged-in profile's settings were read (or after `timeoutMs`, so a failed
 * load never blocks start-up). Resolves immediately when they are already loaded.
 */
export function settingsReady(timeoutMs = 2500): Promise<void> {
  return new Promise((resolve) => {
    if (useSettingsStore.getState().loaded) return resolve();
    let un = () => {};
    const done = () => {
      clearTimeout(timer);
      un();
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    un = useSettingsStore.subscribe((s) => s.loaded && done());
  });
}

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
