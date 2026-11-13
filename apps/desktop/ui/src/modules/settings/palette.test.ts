import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { registerCommands, type Command } from '../../shell/commands';
import { SCHEMA, SECTIONS, settingDef, type SettingKey } from '../../state/settings';
import { settingsPaletteItems } from './palette';

const opened: string[] = [];
const unregister = registerCommands(
  SECTIONS.map((s): Command => ({
    id: `settings.${s.id}`,
    label: `Settings: ${s.label}`,
    group: 'Platform',
    run: () => opened.push(s.id),
  })),
);

afterEach(() => {
  opened.length = 0;
});
afterAll(() => unregister());

describe('settings palette rows', () => {
  const rows = settingsPaletteItems();

  it('has a row for every section and every settings key', () => {
    const keys = Object.keys(SCHEMA) as SettingKey[];
    expect(rows.filter((r) => r.id.startsWith('setting:'))).toHaveLength(keys.length);
    expect(rows.filter((r) => r.id.startsWith('settings.'))).toHaveLength(SECTIONS.length);
    expect(rows.every((r) => r.group === 'Settings')).toBe(true);
  });

  it('opens the section of a key through the Settings section command', () => {
    const key: SettingKey = 'general.language';
    const row = rows.find((r) => r.id === `setting:${key}`)!;
    expect(row.label).toBe(settingDef(key).label);
    row.run();
    expect(opened).toEqual([settingDef(key).section]);
  });

  it('opens a section row at that section', () => {
    rows.find((r) => r.id === 'settings.chart')!.run();
    expect(opened).toEqual(['chart']);
  });
});
