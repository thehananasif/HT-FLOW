import { asAny, type AnyIndicator } from '@htflow/indicator-sdk';
import * as bands from './bands';
import * as bands2 from './bands2';
import * as crypto from './crypto';
import * as ma2 from './ma2';
import * as mtf from './mtf';
import * as orderbook from './orderbook';
import * as orderflow2 from './orderflow2';
import * as osc2 from './osc2';
import * as samples from './samples';
import * as trend2 from './trend2';
import * as levels2 from './levels2';
import * as volume2 from './volume2';
import * as levels from './levels';
import * as ma from './ma';
import * as orderflow from './orderflow';
import * as osc from './oscillators';
import * as trend from './trend';
import * as volumeTech from './volumeTech';
import { CATALOG, type CatalogEntry } from './catalog';

export * from './catalog';
export {
  ma,
  bands,
  osc,
  trend,
  volumeTech,
  levels,
  orderflow,
  ma2,
  bands2,
  trend2,
  osc2,
  volume2,
  levels2,
  orderflow2,
  crypto,
  orderbook,
  samples,
  mtf,
};

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
  ma2,
  bands2,
  trend2,
  osc2,
  volume2,
  levels2,
  orderflow2,
  crypto,
  orderbook,
  samples,
  mtf,
);

const byId = new Map(INDICATORS.map((d) => [d.id, d]));

export function indicatorById(id: string): AnyIndicator | undefined {
  return byId.get(id);
}

export function isImplemented(e: CatalogEntry): boolean {
  return !!e.impl && byId.has(e.impl);
}

export { CATALOG };
