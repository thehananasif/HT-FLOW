import { paperOptionMark } from '@htflow/options';
import { activityLog } from '../modules/activity/log';
import { hub, paper } from '../state/market';

/**
 * Paper options (P18): marks every options position to model with `@htflow/options` pricing and
 * settles expired ones at intrinsic value. The underlying price comes from the live / simulated
 * market store, or from the last option chain the Options Board loaded (Deribit underlyings).
 */
const chainSpots = new Map<string, number>();

/** The Options Board reports each chain's spot (price units) so positions can be marked. */
export function setOptionSpot(underlyingId: string, spot: number): void {
  if (Number.isFinite(spot) && spot > 0) chainSpots.set(underlyingId, spot);
}

/** Underlying price in price units (not ticks), or undefined when unknown. */
export function optionSpot(underlyingId: string): number | undefined {
  const s = hub.peek(underlyingId);
  const last = s?.lastTrade?.px;
  if (s && last !== undefined) return last * s.instrument.tickSize;
  return chainSpots.get(underlyingId);
}

paper.setOptionMarkModel((p) => paperOptionMark(p, optionSpot(p.underlyingId), Date.now()));

/** Settles expired options (runs every second; options without a price wait for one). */
export function settleExpired(now = Date.now()): number {
  const before = paper.optionFills.length;
  const n = paper.settleExpiredOptions(optionSpot, now);
  for (const f of paper.optionFills.slice(before))
    activityLog.add({
      type: 'fill',
      account: paper.accounts.get(f.accountId)?.name ?? f.accountId,
      message: `Option expired: ${f.name ?? `${f.underlyingId} ${f.strike} ${f.right}`} settled at ${f.premium} (realized ${f.realized.toFixed(2)})`,
    });
  return n;
}

setInterval(() => settleExpired(), 1000);
