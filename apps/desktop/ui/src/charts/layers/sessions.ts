import { catalog, matchFeedInstrument, sessionRules } from '@htflow/market-catalog';
import { setSessionResolver, type Instrument, type SessionRules } from '@htflow/market-data';

const cache = new Map<string, SessionRules | null>();

/**
 * Wires RTH / ETH / custom sessions (P07) to the market catalog: the feed instrument is matched
 * to its catalog entry and that entry's exchange sessions are used. Crypto (24/7) and
 * instruments without a catalog entry need no filter.
 */
export function resolveSessionRules(
  inst: Instrument,
  sel: Parameters<Parameters<typeof setSessionResolver>[0]>[1],
): SessionRules | null {
  if (sel === '24h') return null;
  const key = `${inst.id}|${JSON.stringify(sel)}`;
  if (cache.has(key)) return cache.get(key)!;
  let rules: SessionRules | null = null;
  if (inst.assetClass !== 'crypto') {
    const c = matchFeedInstrument(catalog(), inst);
    const sessions = c?.sessions ?? [];
    if (sessions.length || typeof sel === 'object') rules = sessionRules(sessions, sel);
  }
  cache.set(key, rules);
  return rules;
}

setSessionResolver(resolveSessionRules);
