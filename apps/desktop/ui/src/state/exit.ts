import { getSetting } from './settings';
import { askConfirm } from './confirm';
import { paper } from './market';
import { backend } from '../backend';

/** Saves to finish before the window closes (e.g. paper account state). */
export const beforeExit: (() => Promise<void>)[] = [];

/**
 * Closes HT Flow. With Settings → General → "Confirm on exit" on, asks first when positions or
 * working orders are open.
 */
export async function requestExit(): Promise<void> {
  if (getSetting('general.confirmExit')) {
    const positions = paper.allPositions().filter((p) => p.qty !== 0).length;
    const working = paper.workingOrders().length;
    if (positions + working > 0) {
      const ok = await askConfirm({
        title: 'Exit HT Flow',
        body: `You have ${positions} open position${positions === 1 ? '' : 's'} and ${working} working order${working === 1 ? '' : 's'}. Exit anyway?`,
        confirmLabel: 'Exit',
        danger: true,
      });
      if (!ok) return;
    }
  }
  await Promise.all(beforeExit.map((f) => f().catch(() => {})));
  backend.window.close();
}
