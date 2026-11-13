import { domState, type DomWindowState } from '@htflow/workspace';
import { getSetting } from '../../state/settings';

/* Settings → DOM leftovers (P27): default grouping of new DOMs and swapped click sides. */

/** Order side of a ladder click: left buys / right sells, swapped by "Swap left / right click". */
export function clickSide(button: 'left' | 'right', invert: boolean): 'buy' | 'sell' {
  const buy = (button === 'left') !== invert;
  return buy ? 'buy' : 'sell';
}

/** Ticks per row of a newly opened DOM from Settings → DOM "Default price grouping". */
export function defaultGrouping(): number {
  try {
    const g = Number(getSetting('dom.defaultGrouping'));
    return Number.isFinite(g) && g >= 1 ? Math.round(g) : 1;
  } catch {
    return 1;
  }
}

/** A new DOM window with the Settings default grouping. */
export function newDomState(instrumentId: string): DomWindowState {
  return domState(instrumentId, { grouping: defaultGrouping() });
}
