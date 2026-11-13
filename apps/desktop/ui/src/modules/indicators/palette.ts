import { CATEGORIES } from '@htflow/indicator-sdk';
import { isImplemented, type CatalogEntry } from '@htflow/indicators';
import type { PaletteItem } from '../../shell/commands';

/**
 * Palette rows for every implemented catalog indicator (pending entries have nothing to add).
 * `add` runs when the row is chosen, with the catalog entry.
 */
export function indicatorPaletteItems(
  entries: CatalogEntry[],
  add: (e: CatalogEntry) => void,
): PaletteItem[] {
  return entries.filter(isImplemented).map((e) => {
    const category = CATEGORIES.find((c) => c.id === e.category)?.label ?? e.category;
    return {
      id: `indicator:${e.key}`,
      group: 'Indicators',
      label: e.name,
      hint: category,
      keywords: `indicator study add ${e.group ?? ''} ${category}`,
      run: () => add(e),
    };
  });
}
