import { describe, expect, it } from 'vitest';
import {
  applyPresetValues,
  BUILTIN_PRESETS,
  cleanValues,
  deletePreset,
  normalizePresets,
  presetFromSettings,
  savePreset,
} from './footprintQuick';

describe('footprint quick-settings presets', () => {
  it('captures only the quick keys, validated', () => {
    const p = presetFromSettings(
      ' Mine ',
      'bidask',
      {
        'fp.imbRate': 450,
        'fp.vaShow': true,
        'fp.vaColor': '#aabbcc',
        'fp.minDelta': -5, // clamped to the row minimum 0
        'main.background': '#000000', // not a quick key
        'fp.imbDirection': 'sideways', // invalid enum
      },
      'id1',
    );
    expect(p).toEqual({
      id: 'id1',
      name: 'Mine',
      mode: 'bidask',
      values: { 'fp.imbRate': 450, 'fp.vaShow': true, 'fp.vaColor': '#AABBCC', 'fp.minDelta': 0 },
    });
    expect(cleanValues(null)).toEqual({});
  });

  it('loading a preset changes only the quick keys', () => {
    const before = { 'main.background': '#111111', 'fp.vaShow': false, 'fp.minVolume': 0 };
    const after = applyPresetValues(before, BUILTIN_PRESETS[2]!);
    expect(after['main.background']).toBe('#111111');
    expect(after['fp.minVolume']).toBe(50);
    expect(after['fp.imbDirection']).toBe('horizontal');
  });

  it('saves (overwrite by name), deletes and normalises stored presets', () => {
    const a = presetFromSettings('A', 'volume', { 'fp.imbRate': 200 }, 'a');
    let list = savePreset([], a);
    list = savePreset(list, presetFromSettings('a', 'delta', { 'fp.imbRate': 500 }, 'b'));
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe('a');
    expect(list[0]!.values['fp.imbRate']).toBe(500);
    expect(deletePreset(list, 'a')).toEqual([]);
    const stored = normalizePresets([
      list[0],
      { id: 'builtin:x', name: 'nope', mode: 'volume', values: {} },
      { id: 'c', name: '  ', values: {} },
      { id: 'd', name: 'Bad mode', mode: 'zzz', values: { 'fp.poc': 'yes' } },
      'junk',
    ]);
    expect(stored.map((p) => p.id)).toEqual(['a', 'd']);
    expect(stored[1]).toMatchObject({ mode: 'bidask', values: {} });
  });
});
