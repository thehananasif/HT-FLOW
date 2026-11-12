import { describe, expect, it } from 'vitest';
import { chartState, type ChartWindowState } from '@htflow/workspace';
import {
  addTemplate,
  allTemplates,
  applyTemplate,
  captureState,
  defaultFor,
  deleteTemplate,
  duplicateTemplate,
  EMPTY_LIBRARY,
  importTemplates,
  makeTemplate,
  parseLibrary,
  parseTemplatesFile,
  renameTemplate,
  serializeTemplates,
  setClassDefault,
  toggleFavourite,
  uniqueName,
} from './templates';
import { STYLE_PRESETS } from './presets';
import {
  DEFAULTS,
  diffFromDefaults,
  normalizeSettings,
  resetTab,
  ROWS,
  validateValue,
} from './settings/schema';
import { SETTINGS_EXT, chartSettings } from './settings/state';

function chartWith(settings: Record<string, unknown>): ChartWindowState {
  return chartState('mock:BTCUSDT', 'footprint', {
    footprintMode: 'bidask',
    minLots: 5,
    ext: {
      [SETTINGS_EXT]: { settings, panes: { 'volume-pane': 120 }, pinned: true },
      indicators: { items: [{ id: 'ema', length: 21 }] },
      drawings: { list: [1, 2, 3] },
    },
  });
}

describe('chart settings schema', () => {
  it('has a default and a validator for every row', () => {
    for (const r of ROWS) {
      if (r.bind) continue;
      expect(validateValue(r, r.default), r.key).toEqual(r.default);
    }
  });
  it('normalises: drops unknown keys, rejects invalid values, clamps numbers', () => {
    const s = normalizeSettings({
      'main.background': '#123456',
      'axis.fontSize': 400,
      'candles.up': 'red',
      'scales.mode': 'cubic',
      'nope.key': 1,
      'grid.line': { color: '#ABCDEF', style: 'dot', width: 99 },
    });
    expect(s['main.background']).toBe('#123456');
    expect(s['axis.fontSize']).toBe(18);
    expect(s['candles.up']).toBe('');
    expect(s['scales.mode']).toBe('linear');
    expect('nope.key' in s).toBe(false);
    expect(s['grid.line']).toEqual({ color: '#ABCDEF', style: 'dot', width: 8 });
  });
  it('stores only the keys that differ from the defaults', () => {
    const s = { ...DEFAULTS, 'main.background': '#000000', 'scales.invert': true };
    expect(diffFromDefaults(s)).toEqual({ 'main.background': '#000000', 'scales.invert': true });
  });
  it('resets one tab only', () => {
    const s = normalizeSettings({ 'main.background': '#000000', 'fp.imbRate': 500 });
    const r = resetTab(s, 'visual');
    expect(r['main.background']).toBe('');
    expect(r['fp.imbRate']).toBe(500);
  });
});

describe('chart templates', () => {
  it('captures the full chart state but not drawings or instrument', () => {
    const st = captureState(chartWith({ 'main.background': '#101010' }));
    expect(st.template).toBe('footprint');
    expect(st.footprintMode).toBe('bidask');
    expect(st.minLots).toBe(5);
    expect(st.settings).toEqual({ 'main.background': '#101010' });
    expect(st.panes).toEqual({ 'volume-pane': 120 });
    expect(st.ext).toEqual({ indicators: { items: [{ id: 'ema', length: 21 }] } });
    expect(JSON.stringify(st)).not.toContain('BTCUSDT');
  });

  it('round-trips through the .httemplate JSON file', () => {
    const t = makeTemplate('Scalp NQ', chartWith({ 'candles.up': '#00FF00' }), 1000);
    const text = serializeTemplates([t]);
    const { templates, errors } = parseTemplatesFile(text, 2000);
    expect(errors).toEqual([]);
    expect(templates).toHaveLength(1);
    expect(templates[0]).toEqual(t);
    // Applying the parsed template reproduces the settings exactly.
    const target = chartState('mock:ETHUSDT', 'candles-vp');
    const applied = { ...target, ...applyTemplate(target, templates[0]!) } as ChartWindowState;
    expect(chartSettings(applied)['candles.up']).toBe('#00FF00');
    expect(applied.instrumentId).toBe('mock:ETHUSDT');
    expect(applied.template).toBe('footprint');
    expect(applied.ext?.indicators).toEqual({ items: [{ id: 'ema', length: 21 }] });
    expect(captureState(applied)).toEqual(t.state);
  });

  it('rejects invalid files and entries', () => {
    expect(parseTemplatesFile('not json').errors).toHaveLength(1);
    const bad = parseTemplatesFile(
      JSON.stringify({
        kind: 'htflow.chart-templates',
        version: 1,
        templates: [{ kind: 'htflow.chart-template', name: 'x', state: { template: 'nope' } }, 5],
      }),
    );
    expect(bad.templates).toHaveLength(0);
    expect(bad.errors).toHaveLength(2);
  });

  it('save as / rename / duplicate / delete / favourite / class default', () => {
    let lib = addTemplate(EMPTY_LIBRARY, makeTemplate('A', chartWith({}), 1));
    lib = addTemplate(lib, makeTemplate('A', chartWith({}), 2));
    expect(lib.templates.map((t) => t.name)).toEqual(['A', 'A (2)']);
    const [a, b] = lib.templates;
    lib = renameTemplate(lib, b!.id, 'A');
    expect(lib.templates[1]!.name).toBe('A (2)');
    lib = renameTemplate(lib, b!.id, 'Scalp');
    expect(lib.templates[1]!.name).toBe('Scalp');
    lib = duplicateTemplate(lib, a!.id, 3);
    expect(lib.templates).toHaveLength(3);
    expect(lib.templates[2]!.name).toBe('A copy');
    expect(lib.templates[2]!.id).not.toBe(a!.id);
    lib = toggleFavourite(lib, a!.id);
    expect(lib.templates[0]!.favourite).toBe(true);
    lib = setClassDefault(lib, 'crypto', a!.id);
    expect(defaultFor(lib, 'crypto')?.id).toBe(a!.id);
    lib = deleteTemplate(lib, a!.id);
    expect(lib.templates).toHaveLength(2);
    expect(defaultFor(lib, 'crypto')).toBeUndefined();
  });

  it('style presets are read-only, starrable and usable as class defaults', () => {
    const white = STYLE_PRESETS.find((p) => p.name === 'White')!;
    let lib = toggleFavourite(EMPTY_LIBRARY, white.id);
    expect(allTemplates(lib).find((t) => t.id === white.id)?.favourite).toBe(true);
    expect(deleteTemplate(lib, white.id)).toBe(lib);
    lib = setClassDefault(lib, 'future', white.id);
    expect(defaultFor(lib, 'future')?.name).toBe('White');
    const names = STYLE_PRESETS.map((p) => p.name);
    for (const n of ['White', 'Light', 'Dark', 'Black', 'Dark footprint', 'Footprint statistic'])
      expect(names).toContain(n);
    for (const p of STYLE_PRESETS) expect(normalizeSettings(p.state.settings)).toBeTruthy();
  });

  it('imports with fresh ids for duplicates and validates the stored library', () => {
    const t = makeTemplate('X', chartWith({}), 1);
    let lib = addTemplate(EMPTY_LIBRARY, t);
    lib = importTemplates(lib, [t], 5);
    expect(lib.templates).toHaveLength(2);
    expect(new Set(lib.templates.map((x) => x.id)).size).toBe(2);
    expect(lib.templates[1]!.name).toBe('X (2)');
    const back = parseLibrary(JSON.parse(JSON.stringify(lib)));
    expect(back.templates).toEqual(lib.templates);
    expect(parseLibrary(null)).toEqual(EMPTY_LIBRARY);
  });

  it('makes unique names case-insensitively', () => {
    expect(uniqueName('a', ['A', 'a (2)'])).toBe('a (3)');
    expect(uniqueName('  ', [])).toBe('Untitled template');
  });
});
