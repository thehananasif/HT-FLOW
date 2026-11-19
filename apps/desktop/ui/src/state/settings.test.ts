import { beforeEach, describe, expect, it } from 'vitest';
import {
  SCHEMA,
  SECTIONS,
  SETTING_KEYS,
  STATIC_DEFAULTS,
  classifyDelay,
  exportSettings,
  getSetting,
  importSettings,
  isModified,
  modifiedValues,
  normalizeHex,
  parseSettingsFile,
  profileDefaults,
  resetSection,
  sectionKeys,
  setSetting,
  setSettings,
  useSettingsStore,
  validateSetting,
} from './settings';

beforeEach(() => {
  useSettingsStore.setState({ values: STATIC_DEFAULTS, defaults: STATIC_DEFAULTS });
});

describe('settings schema', () => {
  it('every setting has a valid default, help text and a known section', () => {
    const ids = SECTIONS.map((s) => s.id);
    for (const k of SETTING_KEYS) {
      const d = SCHEMA[k];
      expect(ids).toContain(d.section);
      expect(d.help.length).toBeGreaterThan(5);
      const r = validateSetting(k, d.default);
      expect(r.ok, k).toBe(true);
    }
  });

  it('every section has settings', () => {
    for (const s of SECTIONS) expect(sectionKeys(s.id).length, s.id).toBeGreaterThan(0);
  });
});

describe('validation', () => {
  it('rejects out-of-range numbers and snaps to the step', () => {
    expect(validateSetting('general.autoLockMin', 999).ok).toBe(false);
    expect(validateSetting('general.autoLockMin', 'abc').ok).toBe(false);
    expect(validateSetting('appearance.uiScale', 112)).toEqual({ ok: true, value: 110 });
  });
  it('rejects disabled enum options (languages not yet translated)', () => {
    expect(validateSetting('general.language', 'ar').ok).toBe(false);
    expect(validateSetting('general.language', 'ur').ok).toBe(true);
    expect(validateSetting('general.language', 'en').ok).toBe(true);
    expect(validateSetting('appearance.theme', 'neon').ok).toBe(false);
  });
  it('validates token overrides and normalises hex', () => {
    expect(normalizeHex('#abc')).toBe('#AABBCC');
    expect(validateSetting('appearance.tokens', { up: '#00ff00' })).toEqual({
      ok: true,
      value: { up: '#00FF00' },
    });
    expect(validateSetting('appearance.tokens', { nope: '#000000' }).ok).toBe(false);
    expect(validateSetting('appearance.tokens', { up: 'green' }).ok).toBe(false);
  });
  it('validates hotkey bindings and normalises shortcuts', () => {
    const r = validateSetting('hotkeys.bindings', {
      'trading-panel': { shortcut: 'shift+p', scope: 'trading' },
      lock: { shortcut: null },
    });
    expect(r).toEqual({
      ok: true,
      value: {
        'trading-panel': { shortcut: 'Shift+P', scope: 'trading' },
        lock: { shortcut: null },
      },
    });
    expect(validateSetting('hotkeys.bindings', { x: { scope: 'nowhere' } }).ok).toBe(false);
  });
  it('validates time zones and NTP host', () => {
    expect(validateSetting('timezones.app', 'Europe/Berlin').ok).toBe(true);
    expect(validateSetting('timezones.app', 'Mars/Base').ok).toBe(false);
    expect(validateSetting('timezones.chartAxis', 'exchange').ok).toBe(true);
    expect(validateSetting('dataDelays.ntpServer', 'time.google.com:123').ok).toBe(true);
    expect(validateSetting('dataDelays.ntpServer', 'bad host!').ok).toBe(false);
  });
  it('enforces critical latency above warning', () => {
    const e = setSettings({ 'dataDelays.criticalMs': 400 });
    expect(e['dataDelays.criticalMs']).toMatch(/above/);
    expect(getSetting('dataDelays.criticalMs')).toBe(2000);
  });
});

describe('store', () => {
  it('sets, detects modification and resets per section', () => {
    expect(setSetting('general.autoLockMin', 5)).toBeNull();
    expect(getSetting('general.autoLockMin')).toBe(5);
    expect(isModified('general.autoLockMin')).toBe(true);
    expect(modifiedValues(useSettingsStore.getState().values, STATIC_DEFAULTS)).toEqual({
      'general.autoLockMin': 5,
    });
    resetSection('general');
    expect(getSetting('general.autoLockMin')).toBe(30);
  });
  it('profile defaults come from the account theme and time zone', () => {
    const d = profileDefaults({ theme: 'light', timezone: 'Asia/Karachi' });
    expect(d['appearance.theme']).toBe('light');
    expect(d['timezones.app']).toBe('Asia/Karachi');
  });
});

describe('export / import', () => {
  it('round-trips appearance, hotkeys and the rest onto another profile', () => {
    setSettings({
      'appearance.theme': 'gray',
      'appearance.tokens': { up: '#123456' },
      'hotkeys.bindings': { 'trading-panel': { shortcut: 'Shift+P' } },
      'sounds.master': 40,
    });
    const json = JSON.stringify(exportSettings());
    // "another user": different profile defaults, fresh values
    const other = profileDefaults({ theme: 'light', timezone: 'UTC' });
    useSettingsStore.setState({ values: other, defaults: other });
    const r = importSettings(json);
    expect(r.errors).toEqual([]);
    expect(getSetting('appearance.theme')).toBe('gray');
    expect(getSetting('appearance.tokens')).toEqual({ up: '#123456' });
    expect(getSetting('hotkeys.bindings')).toEqual({ 'trading-panel': { shortcut: 'Shift+P' } });
    expect(getSetting('sounds.master')).toBe(40);
  });
  it('reports invalid and unknown keys without applying them', () => {
    const r = parseSettingsFile({
      kind: 'htflow-settings',
      version: 1,
      values: { 'general.autoLockMin': -4, 'bogus.key': 1, 'sounds.master': 10 },
    });
    expect(r.applied).toBe(1);
    expect(r.errors.length).toBe(2);
    expect(r.values['general.autoLockMin']).toBe(30);
    expect(parseSettingsFile('not json').errors[0]).toMatch(/JSON/);
    expect(parseSettingsFile({ kind: 'other' }).errors[0]).toMatch(/Not an HT Flow/);
  });
});

describe('data delays', () => {
  it('classifies latency and staleness', () => {
    const v = {
      'dataDelays.warningMs': 500,
      'dataDelays.criticalMs': 2000,
      'dataDelays.criticalLastUpdateSec': 10,
    };
    expect(classifyDelay(100, 0, v)).toBe('ok');
    expect(classifyDelay(600, 0, v)).toBe('warning');
    expect(classifyDelay(2500, 0, v)).toBe('critical');
    expect(classifyDelay(10, 11_000, v)).toBe('critical');
  });
});
