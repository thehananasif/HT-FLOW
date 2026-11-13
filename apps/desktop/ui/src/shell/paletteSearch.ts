import type { Command, PaletteItem } from './commands';

/** One selectable palette row. Commands keep their own group badge; items sit under a header. */
export type PaletteRow =
  { kind: 'command'; command: Command } | { kind: 'item'; item: PaletteItem };

/** Commands shown with an empty query, and with a query (as before the item groups existed). */
export const COMMAND_LIMIT = 60;
/** Rows per item group (Indicators, Settings) for one query. */
export const ITEM_LIMIT = 30;

/** Headers for item groups, in display order (after the command results). */
export const ITEM_GROUPS: PaletteItem['group'][] = ['Indicators', 'Settings'];

/**
 * Every term must appear in the haystack (case-insensitive substring). Score: a term at the start
 * scores 3, at a word start 2, inside a word 1. Null when a term is missing.
 */
export function matchScore(hay: string, terms: string[]): number | null {
  let score = 0;
  for (const t of terms) {
    const i = hay.indexOf(t);
    if (i < 0) return null;
    score += i === 0 ? 3 : hay[i - 1] === ' ' ? 2 : 1;
  }
  return score;
}

function rank<T>(entries: { value: T; hay: string }[], terms: string[]): T[] {
  return entries
    .map((e) => ({ value: e.value, score: matchScore(e.hay, terms) }))
    .filter((x): x is { value: T; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.value);
}

/**
 * The palette results for a query: command matches first (existing behaviour), then indicator and
 * settings matches under their group headers. An item whose id equals a matched command is dropped
 * (for example "Settings: Chart" is already a command). With an empty query only commands show.
 */
export function searchPalette(
  query: string,
  commands: Command[],
  items: PaletteItem[],
): PaletteRow[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length)
    return commands.slice(0, COMMAND_LIMIT).map((command) => ({ kind: 'command', command }));

  const commandHits = rank(
    commands.map((c) => ({
      value: c,
      hay: `${c.label} ${c.group} ${c.keywords ?? ''}`.toLowerCase(),
    })),
    terms,
  ).slice(0, COMMAND_LIMIT);
  const shown = new Set(commandHits.map((c) => c.id));

  const itemRows: PaletteRow[] = ITEM_GROUPS.flatMap((group) =>
    rank(
      items
        .filter((i) => i.group === group && !shown.has(i.id))
        .map((item) => ({
          value: item,
          hay: `${item.label} ${item.group} ${item.hint ?? ''} ${item.keywords ?? ''}`.toLowerCase(),
        })),
      terms,
    )
      .slice(0, ITEM_LIMIT)
      .map((item): PaletteRow => ({ kind: 'item', item })),
  );

  return [...commandHits.map((command): PaletteRow => ({ kind: 'command', command })), ...itemRows];
}

/** Stable key for React lists and selection. */
export function rowKey(row: PaletteRow): string {
  return row.kind === 'command' ? `cmd:${row.command.id}` : `item:${row.item.id}`;
}
