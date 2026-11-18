import { asAny, type AnyIndicator } from '@htflow/indicator-sdk';
import * as account from './account';
import * as bands from './bands';
import * as bands2 from './bands2';
import * as cot from './cot';
import * as crypto from './crypto';
import * as custom from './custom';
import * as ma2 from './ma2';
import * as mtf from './mtf';
import * as optionsPos from './optionsPos';
import * as orderbook from './orderbook';
import * as orderflow2 from './orderflow2';
import * as osc2 from './osc2';
import * as samples from './samples';
import * as second from './second';
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
  cot,
  orderbook,
  samples,
  mtf,
  custom,
  second,
  account,
  optionsPos,
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
  cot,
  orderbook,
  samples,
  mtf,
  custom,
  second,
  account,
  optionsPos,
);

/**
 * Built-ins whose calc() rewrites earlier bars (checked for every other built-in by
 * incremental.test.ts). Indicators with a timeframe input are left out too: a higher-timeframe
 * value can be spread over the chart bars of its period.
 */
const REVISES_HISTORY = new Set(['zigzag', 'ichimoku']);
for (const d of INDICATORS)
  if (
    d.stableHistory === undefined &&
    !REVISES_HISTORY.has(d.id) &&
    !Object.values(d.inputs).some((x) => x.type === 'timeframe')
  )
    d.stableHistory = true;

const byId = new Map(INDICATORS.map((d) => [d.id, d]));

/** Indicators added at run time (user `.htind` scripts, id `script:<slug>`). */
const dynamic = new Map<string, AnyIndicator>();

export function registerIndicator(def: AnyIndicator): void {
  if (byId.has(def.id)) throw new Error(`Indicator id ${def.id} is built in`);
  dynamic.set(def.id, def);
}

export function unregisterIndicator(id: string): void {
  dynamic.delete(id);
}

export function dynamicIndicators(): AnyIndicator[] {
  return [...dynamic.values()];
}

export function indicatorById(id: string): AnyIndicator | undefined {
  return byId.get(id) ?? dynamic.get(id);
}

/**
 * Indicators that read the tape or the derivatives / depth feeds run on the main thread; the
 * rest can be computed by the worker pool (Stage 8).
 */
const FEED_IDS = new Set(collect(crypto, orderbook, cot).map((d) => d.id));
export function poolable(def: AnyIndicator): boolean {
  return (
    !def.needsTrades &&
    !def.needsHost &&
    !FEED_IDS.has(def.id) &&
    !FEED_IDS.has(def.id.replace(/^mtf-/, ''))
  );
}

export function isImplemented(e: CatalogEntry): boolean {
  return !!e.impl && byId.has(e.impl);
}

export { CATALOG };
