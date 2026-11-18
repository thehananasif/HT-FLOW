import type { AccountSnapshot } from '@htflow/indicator-sdk';
import { pnlPerTick, type PaperEngine } from '@htflow/trading';

export interface AccountFeedDeps {
  paper: PaperEngine;
  /** The account that trades `instrumentId` (replay routing applied). */
  accountFor(instrumentId: string): string;
  economics(instrumentId: string): { tickSize: number; tickValue: number };
  /** Last price of an instrument in ticks (undefined without a feed). */
  last(instrumentId: string): number | undefined;
}

/**
 * Read-only snapshot of the trading account for the indicator context (Account Info Display,
 * Position Sizing Tracker, Options Position / Risk Profile). Never creates or changes anything in
 * the paper engine. Null when the account does not exist.
 */
export function buildAccountSnapshot(
  d: AccountFeedDeps,
  instrumentId: string,
): AccountSnapshot | null {
  const id = d.accountFor(instrumentId);
  const acc = d.paper.accounts.get(id);
  if (!acc) return null;
  let qty = 0;
  let avgPx = 0;
  let other = 0;
  const open = d.paper.allPositions(id);
  for (const p of open) {
    if (p.instrumentId === instrumentId) {
      qty = p.qty;
      avgPx = p.avgPx;
      continue;
    }
    const mark = d.last(p.instrumentId);
    if (mark !== undefined) other += d.paper.unrealized(id, p.instrumentId, mark);
  }
  const options = d.paper
    .optionPositions(id)
    .filter((o) => o.underlyingId === instrumentId && o.qty !== 0)
    .map((o) => ({
      id: o.id,
      right: o.right,
      strike: o.strike,
      expiry: o.expiry,
      ...(o.expiryTs !== undefined ? { expiryTs: o.expiryTs } : {}),
      ...(o.iv !== undefined ? { iv: o.iv } : {}),
      ...(o.model !== undefined ? { model: o.model } : {}),
      ...(o.r !== undefined ? { r: o.r } : {}),
      ...(o.q !== undefined ? { q: o.q } : {}),
      ...(o.basis !== undefined ? { basis: o.basis } : {}),
      ...(o.name !== undefined ? { name: o.name } : {}),
      qty: o.qty,
      avgPremium: o.avgPremium,
      multiplier: o.multiplier,
    }));
  return {
    version: d.paper.version,
    name: acc.name,
    currency: acc.currency,
    startingBalance: acc.startingBalance,
    balance: acc.balance,
    positionQty: qty,
    avgPx,
    pnlPerTick: pnlPerTick(d.economics(instrumentId), 1),
    otherUnrealized: other,
    openPositions: open.length + options.length,
    options,
  };
}
