import { asAny, type AnyIndicator } from '@htflow/indicator-sdk';
import * as bands from './bands';
import * as levels from './levels';
import * as ma from './ma';
import * as orderflow from './orderflow';
import * as osc from './oscillators';
import * as trend from './trend';
import * as volumeTech from './volumeTech';
import { CATALOG, type CatalogEntry } from './catalog';

export * from './catalog';
export { ma, bands, osc, trend, volumeTech, levels, orderflow };

function collect(...mods: Record<string, unknown>[]): AnyIndicator[] {
  const out: AnyIndicator[] = [];
  for (const m of mods)
    for (const v of Object.values(m))
      if (v && typeof v === 'object' && 'calc' in v && 'id' in v) out.push(asAny(v as never));
  return out;
}

/** Every implemented indicator. */
export const INDICATORS: AnyIndicator[] = collect(
  orderflow,
  ma,
  bands,
  osc,
  trend,
  volumeTech,
  levels,
);

const byId = new Map(INDICATORS.map((d) => [d.id, d]));

export function indicatorById(id: string): AnyIndicator | undefined {
  return byId.get(id);
}

export function isImplemented(e: CatalogEntry): boolean {
  return !!e.impl && byId.has(e.impl);
}

export { CATALOG };
