import type { CatalogGroup, CatalogInstrument } from './types';
import { FUTURES } from './seed/futures';
import { CRYPTO } from './seed/crypto';
import { DXFEED_GROUPS, OTHER } from './seed/other';
import { SearchIndex } from './search';
import { frontContract, nextRoll, parseContractCode } from './expiry';

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

  constructor(instruments: CatalogInstrument[]) {
    this.instruments = instruments;
    for (const i of instruments) {
      if (this.byId.has(i.id)) throw new Error(`Duplicate catalog id ${i.id}`);
      this.byId.set(i.id, i);
    }
    this.index = new SearchIndex(instruments);
  }

  get(id: string): CatalogInstrument | undefined {
    return this.byId.get(id);
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
  frontCode(i: CatalogInstrument, now = new Date()): string {
    if (!i.contract) return i.symbol;
    return frontContract(i.root, i.contract, now)?.code ?? i.symbol;
  }

  nextRoll(i: CatalogInstrument, now = new Date()) {
    return i.contract ? nextRoll(i.root, i.contract, now) : null;
  }
}

export const CATALOG_SEED: CatalogInstrument[] = [...FUTURES, ...CRYPTO, ...OTHER];

let shared: Catalog | null = null;

/** The built-in catalog (built lazily once). */
export function catalog(): Catalog {
  if (!shared) shared = new Catalog(CATALOG_SEED);
  return shared;
}
