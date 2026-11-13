import { describe, expect, it } from 'vitest';
import type { Command, PaletteItem } from './commands';
import {
  COMMAND_LIMIT,
  ITEM_LIMIT,
  matchScore,
  rowKey,
  searchPalette,
  type PaletteRow,
} from './paletteSearch';

const noop = () => {};
const cmd = (id: string, label: string, extra: Partial<Command> = {}): Command => ({
  id,
  label,
  group: 'Chart',
  run: noop,
  ...extra,
});
const item = (
  id: string,
  group: PaletteItem['group'],
  label: string,
  extra: Partial<PaletteItem> = {},
): PaletteItem => ({ id, group, label, run: noop, ...extra });

const commands = [
  cmd('chart.rsi', 'Chart: Toggle RSI cross'),
  cmd('chart.zoom', 'Chart: Zoom to fit'),
  cmd('settings.chart', 'Settings: Chart', { group: 'Platform' }),
  cmd('layout.grid', 'Layout: Grid'),
];
const items = [
  item('indicator:technical:rsi', 'Indicators', 'RSI', { hint: 'Oscillators' }),
  item('indicator:technical:ema', 'Indicators', 'EMA', { hint: 'Moving averages' }),
  item('settings.chart', 'Settings', 'Chart', { hint: 'Section' }),
  item('setting:chart.background', 'Settings', 'Background', { hint: 'Chart › Colours' }),
  item('setting:general.language', 'Settings', 'Language', { hint: 'General › Language & region' }),
];

const ids = (rows: PaletteRow[]) => rows.map((r) => rowKey(r));

describe('matchScore', () => {
  it('requires every term and scores word starts above inner matches', () => {
    expect(matchScore('rsi 14', ['rsi'])).toBe(3);
    expect(matchScore('chart rsi', ['rsi'])).toBe(2);
    expect(matchScore('chart corsi', ['rsi'])).toBe(1);
    expect(matchScore('chart rsi', ['rsi', 'ema'])).toBeNull();
  });
});

describe('searchPalette', () => {
  it('with an empty query shows only commands, capped as before', () => {
    const many = Array.from({ length: COMMAND_LIMIT + 5 }, (_, i) => cmd(`c${i}`, `Cmd ${i}`));
    const rows = searchPalette('  ', many, items);
    expect(rows).toHaveLength(COMMAND_LIMIT);
    expect(rows.every((r) => r.kind === 'command')).toBe(true);
  });

  it('lists command matches first, then Indicators, then Settings', () => {
    const rows = searchPalette('rsi', commands, items);
    expect(ids(rows)).toEqual(['cmd:chart.rsi', 'item:indicator:technical:rsi']);
  });

  it('keeps group order Indicators before Settings for a broad query', () => {
    const rows = searchPalette('e', commands, items);
    const groups = rows.map((r) => (r.kind === 'item' ? r.item.group : 'command'));
    const firstItem = groups.indexOf('Indicators');
    const firstSetting = groups.indexOf('Settings');
    expect(groups.slice(0, firstItem).every((g) => g === 'command')).toBe(true);
    expect(firstItem).toBeLessThan(firstSetting);
    expect(groups.lastIndexOf('Indicators')).toBeLessThan(firstSetting);
  });

  it('finds an indicator by name, case-insensitively, and by category hint', () => {
    expect(ids(searchPalette('EMA', commands, items))).toContain('item:indicator:technical:ema');
    expect(ids(searchPalette('moving', commands, items))).toEqual(['item:indicator:technical:ema']);
  });

  it('finds settings keys and sections, matching the section and group text too', () => {
    expect(ids(searchPalette('background', commands, items))).toEqual([
      'item:setting:chart.background',
    ]);
    expect(ids(searchPalette('colours', commands, items))).toEqual([
      'item:setting:chart.background',
    ]);
  });

  it('drops a settings section item when its "Settings: …" command already matched', () => {
    const rows = searchPalette('chart', commands, items);
    expect(ids(rows)).toContain('cmd:settings.chart');
    expect(ids(rows).filter((k) => k === 'item:settings.chart')).toHaveLength(0);
    expect(ids(rows)).toContain('item:setting:chart.background');
  });

  it('keeps a section item when its command did not match the query', () => {
    const rows = searchPalette('chart', [cmd('layout.grid', 'Layout: Grid')], items);
    expect(ids(rows)).toContain('item:settings.chart');
  });

  it('caps each item group', () => {
    const many = Array.from({ length: ITEM_LIMIT + 10 }, (_, i) =>
      item(`indicator:x${i}`, 'Indicators', `Thing ${i}`),
    );
    const rows = searchPalette('thing', [], many);
    expect(rows).toHaveLength(ITEM_LIMIT);
  });

  it('returns nothing when no row matches', () => {
    expect(searchPalette('zzzz', commands, items)).toEqual([]);
  });
});
