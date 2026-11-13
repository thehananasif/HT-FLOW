import { runCommand, type PaletteItem } from '../../shell/commands';
import { SCHEMA, SECTIONS, settingDef, type SettingKey } from '../../state/settings';

/**
 * Palette rows for every settings section and every settings key. Choosing one opens the Settings
 * window at its section, through the same `settings.<section>` command the Settings menu uses.
 * Section ids match those commands, so the palette drops a duplicate when the command matched.
 */
export function settingsPaletteItems(): PaletteItem[] {
  const sectionLabel = (id: string) => SECTIONS.find((s) => s.id === id)?.label ?? id;
  const sections: PaletteItem[] = SECTIONS.map((s) => ({
    id: `settings.${s.id}`,
    group: 'Settings',
    label: s.label,
    hint: 'Section',
    keywords: `settings section preferences ${s.description}`,
    run: () => runCommand(`settings.${s.id}`),
  }));
  const keys: PaletteItem[] = (Object.keys(SCHEMA) as SettingKey[]).map((key) => {
    const def = settingDef(key);
    return {
      id: `setting:${key}`,
      group: 'Settings',
      label: def.label,
      hint: `${sectionLabel(def.section)} › ${def.group}`,
      keywords: `${key} setting ${def.keywords ?? ''}`,
      run: () => runCommand(`settings.${def.section}`),
    };
  });
  return [...sections, ...keys];
}
