/** Slots of extension items in the chart right-click menu (P26 order). */
import type { MenuEntry } from '@htflow/ui-kit';

export type ExtSlot =
  'context' | 'trade' | 'trading' | 'indicators' | 'drawing' | 'strategies' | 'replay' | 'more';

/**
 * Where an extension's menu item goes in the P26 order: context items (the drawing, indicator or
 * order under the cursor) first, then trade / alert items at the cursor price, and the named
 * slots (Indicators, Drawing objects, Chart strategies, Add replay template); the rest goes last.
 */
export function extSlot(id: string): ExtSlot {
  if (id === 'indicators') return 'indicators';
  if (id === 'dr-objects') return 'drawing';
  if (id.startsWith('strategy')) return 'strategies';
  if (id.startsWith('replay-')) return 'replay';
  if (id === 'ctr-toggle') return 'trading';
  if (id === 'ctr-more' || id.startsWith('alert')) return 'trade';
  if (id.startsWith('dr-') || id.startsWith('ind-') || id.startsWith('ctr-')) return 'context';
  return 'more';
}

/** Groups extension items by slot (extension separators are dropped; the menu adds its own). */
export function slotExtensionItems(items: MenuEntry[]): Record<ExtSlot, MenuEntry[]> {
  const out: Record<ExtSlot, MenuEntry[]> = {
    context: [],
    trade: [],
    trading: [],
    indicators: [],
    drawing: [],
    strategies: [],
    replay: [],
    more: [],
  };
  for (const e of items) {
    if (e.kind === 'separator') continue;
    out[extSlot(e.id)].push(e);
  }
  return out;
}
