import type { CatalogGroup, CatalogInstrument } from './types';
import { FUTURES } from './seed/futures';
import { CRYPTO } from './seed/crypto';
import { DXFEED_GROUPS, OTHER } from './seed/other';
import { SearchIndex } from './search';
import { mergeDiscovered, type DiscoveredInstrument } from './discovered';
import { normalizeCryptoSymbol } from './normalize';
import { frontContract, nextRoll, parseContractCode, type ContractVolumes } from './expiry';

/** Appendix A top-level groups, in order. */
export const GROUP_ORDER = [
  'US and EU Futures',
  'Crypto',
  'US Stocks & Other',
  'Single Stock Futures',
  'dxFeed',
];

export class Catalog {
  readonly instruments: CatalogInstrument[];
  readonly index: SearchIndex<CatalogInstrument>;
  private byId = new Map<string, CatalogInstrument>();
  /** Feed id (`${provider}:${symbol}`, or the full sim id) → entry. */
  private byFeed = new Map<string, CatalogInstrument>();
  /** Normalised crypto symbol → crypto entries (built on first use). */
  private byNorm: Map<string, CatalogInstrument[]> | null = null;

  constructor(instruments: CatalogInstrument[]) {
    this.instruments = instruments;
    for (const i of instruments) {
      if (this.byId.has(i.id)) throw new Error(`Duplicate catalog id ${i.id}`);
      this.byId.set(i.id, i);
      for (const p of i.providers) {
        const fid = p.provider === 'sim' ? p.symbol : `${p.provider}:${p.symbol}`;
        if (!this.byFeed.has(fid)) this.byFeed.set(fid, i);
      }
    }
    this.index = new SearchIndex(instruments);
  }

  get(id: string): CatalogInstrument | undefined {
    return this.byId.get(id);
  }

  /** Entry whose provider mapping is exactly this feed id. */
  byFeedId(feedId: string): CatalogInstrument | undefined {
    return this.byFeed.get(feedId);
  }

  /** Crypto entries with this normalised symbol (see normalizeCryptoSymbol). */
  cryptoBySymbol(norm: string): CatalogInstrument[] {
    if (!this.byNorm) {
      this.byNorm = new Map();
      for (const i of this.instruments) {
        if (i.assetClass !== 'crypto') continue;
        const k = normalizeCryptoSymbol(i.symbol);
        const l = this.byNorm.get(k);
        if (l) l.push(i);
        else this.byNorm.set(k, [i]);
      }
    }
    return this.byNorm.get(norm) ?? [];
  }

  /** First futures instrument with this root (optionally on this exchange). */
  byRoot(root: string, exchange?: string): CatalogInstrument | undefined {
    return this.instruments.find(
      (i) =>
        i.root === root &&
        i.contract &&
        i.assetClass === 'future' &&
        (!exchange || i.exchange.toLowerCase() === exchange.toLowerCase()),
    );
  }

  /** Resolves a dated contract code ("CLZ6") to its root instrument. */
  byContractCode(code: string, exchange?: string): CatalogInstrument | undefined {
    const p = parseContractCode(code);
    return p ? this.byRoot(p.root, exchange) : undefined;
  }

  /** Picker tree: group → sub-group → ids, Appendix A order, plus dxFeed exchange views. */
  tree(): CatalogGroup[] {
    const groups = new Map<string, Map<string, string[]>>();
    for (const i of this.instruments) {
      let g = groups.get(i.group);
      if (!g) groups.set(i.group, (g = new Map()));
      let s = g.get(i.subGroup);
      if (!s) g.set(i.subGroup, (s = []));
      s.push(i.id);
    }
    const out: CatalogGroup[] = [...groups.entries()].map(([name, subs]) => ({
      name,
      subGroups: [...subs.entries()].map(([n, ids]) => ({ name: n, ids })),
    }));
    out.push({
      name: 'dxFeed',
      subGroups: DXFEED_GROUPS.map((g) => ({
        name: g.name,
        ids: this.instruments
          .filter(
            (i) =>
              i.assetClass === 'future' &&
              g.exchanges.includes(i.exchange) &&
              (!g.roots || g.roots.includes(i.root)),
          )
          .map((i) => i.id),
      })),
    });
    return out.sort((a, b) => GROUP_ORDER.indexOf(a.name) - GROUP_ORDER.indexOf(b.name));
  }

  /** Front contract code ("CLZ6") for a dated future at `now`; the symbol otherwise. */
  frontCode(i: CatalogInstrument, now = new Date(), volumes?: ContractVolumes): string {
    if (!i.contract) return i.symbol;
    return frontContract(i.root, i.contract, now, 1, volumes)?.code ?? i.symbol;
  }

  nextRoll(i: CatalogInstrument, now = new Date(), volumes?: ContractVolumes) {
    return i.contract ? nextRoll(i.root, i.contract, now, 1, volumes) : null;
  }
}

export const CATALOG_SEED: CatalogInstrument[] = [...FUTURES, ...CRYPTO, ...OTHER];

let shared: Catalog | null = null;
let version = 0;
const listeners = new Set<() => void>();

/** The catalog: the built-in seed, merged with live-discovered instruments once they load. */
export function catalog(): Catalog {
  if (!shared) shared = new Catalog(CATALOG_SEED);
  return shared;
}

/**
 * Rebuilds the shared catalog from the seed plus live-discovered instruments (desktop symbol
 * discovery). An empty list restores the seed. Listeners run after the swap.
 */
export function setDiscoveredInstruments(list: readonly DiscoveredInstrument[]): Catalog {
  shared = new Catalog(mergeDiscovered(CATALOG_SEED, list));
  version++;
  listeners.forEach((l) => l());
  return shared;
}

/** Bumped on every catalog rebuild (memo key for pickers). */
export function catalogVersion(): number {
  return version;
}

export function onCatalogChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
