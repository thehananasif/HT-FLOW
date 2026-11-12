import { beforeEach, describe, expect, it } from 'vitest';
import {
  SCHEMA,
  SECTIONS,
  SETTING_KEYS,
  STATIC_DEFAULTS,
  parseSettingsFile,
  resetSection,
  sectionKeys,
  setSetting,
  settingDef,
  useSettingsStore,
  validateSetting,
  exportSettings,
  type SectionId,
} from './settings';
import { levelEnabled } from './log';
import { layoutDirection } from '../modules/settings/effects';
import { needsConfirm } from './confirm';
import { getSetting } from './settings';

beforeEach(() => {
  useSettingsStore.setState({ values: STATIC_DEFAULTS, defaults: STATIC_DEFAULTS });
});

const NEW_SECTIONS: SectionId[] = [
  'chart',
  'footprint',
  'heatmap',
  'dom',
  'tape',
  'trading',
  'data',
  'alerts',
  'risk',
  'privacy',
  'logs',
  'modules',
  'about',
];

describe('settings sections (P27 / P43)', () => {
  it('lists every section the spec names, each with fields', () => {
    const ids = SECTIONS.map((s) => s.id);
    for (const s of NEW_SECTIONS) {
      expect(ids, s).toContain(s);
      expect(sectionKeys(s).length, s).toBeGreaterThan(1);
    }
  });

  it('every field has help text, a group, a label and a default that validates', () => {
    for (const k of SETTING_KEYS) {
      const d = settingDef(k);
      expect(d.label.length, k).toBeGreaterThan(1);
      expect(d.group.length, k).toBeGreaterThan(1);
      expect(d.help.length, k).toBeGreaterThan(10);
      expect(validateSetting(k, d.default).ok, k).toBe(true);
    }
  });

  it('keys are prefixed with their home section', () => {
    const own: Record<string, string> = { dataDelays: 'dataDelays', timezones: 'timezones' };
    for (const k of SETTING_KEYS) {
      const home = SCHEMA[k].section;
      expect(k.startsWith(`${own[home] ?? home}.`), k).toBe(true);
    }
  });

  it('reset of a section restores its defaults', () => {
    setSetting('dom.rowHeight', 30);
    setSetting('tape.showMs', false);
    expect(getSetting('dom.rowHeight')).toBe(30);
    resetSection('dom');
    expect(getSetting('dom.rowHeight')).toBe(22);
    expect(getSetting('tape.showMs')).toBe(false); // other section untouched
  });
});

describe('colour settings', () => {
  it('accept empty (follow the theme) and normalise hex', () => {
    expect(validateSetting('chart.candleUp', '')).toEqual({ ok: true, value: '' });
    expect(validateSetting('chart.candleUp', '#0f0')).toEqual({ ok: true, value: '#00FF00' });
    expect(validateSetting('chart.candleUp', '#12345678').ok).toBe(false);
    expect(validateSetting('chart.candleUp', 'green').ok).toBe(false);
    expect(validateSetting('chart.candleUp', 12).ok).toBe(false);
  });
});

describe('number ranges and snapping', () => {
  it('rejects out-of-range values', () => {
    expect(validateSetting('dom.rowHeight', 5).ok).toBe(false);
    expect(validateSetting('dom.rowHeight', 41).ok).toBe(false);
    expect(validateSetting('footprint.imbalanceRatio', 100).ok).toBe(false);
    expect(validateSetting('logs.keepDays', 0).ok).toBe(false);
    expect(validateSetting('risk.warnAtPct', 'x').ok).toBe(false);
  });
  it('snaps to the step', () => {
    expect(validateSetting('footprint.imbalanceRatio', 304)).toEqual({ ok: true, value: 300 });
    expect(validateSetting('chart.gridOpacity', 42)).toEqual({ ok: true, value: 40 });
  });
});

describe('enums', () => {
  it('rejects unknown values', () => {
    expect(validateSetting('chart.crosshairStyle', 'wavy').ok).toBe(false);
    expect(validateSetting('logs.level', 'trace').ok).toBe(false);
    expect(validateSetting('logs.level', 'debug').ok).toBe(true);
  });
  it('telemetry can never be switched on', () => {
    expect(validateSetting('privacy.telemetry', 'off').ok).toBe(true);
    expect(validateSetting('privacy.telemetry', 'on').ok).toBe(false);
    expect(validateSetting('privacy.crashReports', 'upload').ok).toBe(false);
    expect(STATIC_DEFAULTS['privacy.telemetry']).toBe('off');
  });
  it('Urdu and Arabic are listed as coming and cannot be selected yet', () => {
    const lang = SCHEMA['general.language'];
    for (const v of ['ur', 'ar']) {
      const o = lang.options.find((x) => x.value === v)!;
      expect(o.label).toMatch(/coming/);
      expect(o.label).toMatch(/RTL/);
      expect(validateSetting('general.language', v).ok).toBe(false);
    }
    expect(validateSetting('general.rtl', 'rtl').ok).toBe(true);
    expect(validateSetting('about.updateChannel', 'beta').ok).toBe(false);
  });
});

describe('string settings', () => {
  it('quantity presets must be comma-separated numbers', () => {
    expect(validateSetting('trading.qtyPresets', '1, 2').ok).toBe(false);
    expect(validateSetting('trading.qtyPresets', '1,2,5,10')).toEqual({
      ok: true,
      value: '1,2,5,10',
    });
    expect(validateSetting('trading.qtyPresets', 'a,b').ok).toBe(false);
    expect(validateSetting('trading.qtyPresets', '1,2,3,4,5,6,7,8,9,10,11,12,13').ok).toBe(false);
  });
  it('log folder rejects illegal path characters', () => {
    expect(validateSetting('logs.folder', 'D:\\HT\\logs').ok).toBe(true);
    expect(validateSetting('logs.folder', 'D:\\HT|logs').ok).toBe(false);
    expect(validateSetting('logs.folder', '').ok).toBe(false);
  });
});

describe('list settings', () => {
  it('provider priority keeps every known provider and de-duplicates', () => {
    const r = validateSetting('data.providerPriority', ['replay', 'replay', 'mock']);
    expect(r.ok && r.value).toEqual(['replay', 'mock', 'binance-futures', 'bybit-linear']);
    expect(validateSetting('data.providerPriority', 'replay').ok).toBe(false);
    expect(validateSetting('data.providerPriority', ['bad id!']).ok).toBe(false);
  });
  it('disabled modules are a de-duplicated id list', () => {
    expect(validateSetting('modules.disabled', ['journal', 'journal', 'risk'])).toEqual({
      ok: true,
      value: ['journal', 'risk'],
    });
    expect(validateSetting('modules.disabled', [1]).ok).toBe(false);
    expect(validateSetting('modules.disabled', ['a b']).ok).toBe(false);
  });
  it('module folders reject illegal paths and more than 20 entries', () => {
    expect(validateSetting('modules.folders', ['C:\\HTFlow\\mods'])).toEqual({
      ok: true,
      value: ['C:\\HTFlow\\mods'],
    });
    expect(validateSetting('modules.folders', ['C:\\a*b']).ok).toBe(false);
    expect(validateSetting('modules.folders', ['']).ok).toBe(false);
    expect(
      validateSetting(
        'modules.folders',
        Array.from({ length: 21 }, (_, i) => `d${i}`),
      ).ok,
    ).toBe(false);
  });
});

describe('import / export of the new keys', () => {
  it('round-trips changed values and rejects invalid ones with a message', () => {
    setSetting('chart.candleUp', '#112233');
    setSetting('modules.disabled', ['journal']);
    const file = exportSettings();
    const r = parseSettingsFile(file);
    expect(r.errors).toEqual([]);
    expect(r.values['chart.candleUp']).toBe('#112233');
    expect(r.values['modules.disabled']).toEqual(['journal']);

    const bad = parseSettingsFile({
      kind: 'htflow-settings',
      version: 1,
      values: { 'dom.rowHeight': 999, 'privacy.telemetry': 'on', 'tape.showMs': false },
    });
    expect(bad.applied).toBe(1);
    expect(bad.errors.length).toBe(2);
    expect(bad.values['dom.rowHeight']).toBe(22);
  });
});

describe('layout direction flag', () => {
  it('follows the flag, or an RTL language', () => {
    expect(layoutDirection({ 'general.rtl': 'auto', 'general.language': 'en' })).toBe('ltr');
    expect(layoutDirection({ 'general.rtl': 'rtl', 'general.language': 'en' })).toBe('rtl');
    expect(layoutDirection({ 'general.rtl': 'ltr', 'general.language': 'ar' })).toBe('ltr');
    expect(layoutDirection({ 'general.rtl': 'auto', 'general.language': 'ur' })).toBe('rtl');
  });
});

describe('log levels', () => {
  it('records a level only when it is at or above the threshold', () => {
    expect(levelEnabled('error', 'warn')).toBe(true);
    expect(levelEnabled('info', 'warn')).toBe(false);
    expect(levelEnabled('debug', 'debug')).toBe(true);
  });
});

describe('confirmations follow the settings', () => {
  it('flatten, order, table and close-window rules', () => {
    expect(needsConfirm('flatten')).toBe(true); // default on
    expect(needsConfirm('order')).toBe(false); // default off
    setSetting('general.confirmOrders', true);
    expect(needsConfirm('order')).toBe(true);
    // table row actions ask unless "skip confirmations in tables"
    expect(needsConfirm('tableAction', { fromTable: true })).toBe(true);
    setSetting('common.skipTableConfirmations', true);
    expect(needsConfirm('tableAction', { fromTable: true })).toBe(false);
    expect(needsConfirm('flatten', { fromTable: true })).toBe(false);
    expect(needsConfirm('flatten')).toBe(true);
    // closing: only when asked, module windows follow "don't ask again"
    expect(needsConfirm('closeWindow')).toBe(false);
    setSetting('general.confirmCloseWindow', true);
    expect(needsConfirm('closeWindow', { module: false })).toBe(true);
    expect(needsConfirm('closeWindow', { module: true })).toBe(false); // closeDontAsk default
    setSetting('common.closeDontAsk', false);
    expect(needsConfirm('closeWindow', { module: true })).toBe(true);
  });
});
