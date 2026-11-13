import { createConfig, resolveInputs, type IndicatorConfig } from '@htflow/indicator-sdk';
import { indicatorById, type CatalogEntry } from '@htflow/indicators';

/**
 * The indicator config a catalog entry adds to a chart (its implementation with the entry's preset
 * inputs). Null for pending entries, which have no implementation yet.
 */
export function buildIndicatorConfig(e: CatalogEntry): IndicatorConfig | null {
  const d = e.impl ? indicatorById(e.impl) : undefined;
  if (!d) return null;
  const cfg = createConfig(d);
  cfg.inputs = { ...resolveInputs(d.inputs, { ...cfg.inputs, ...e.inputs }) };
  return cfg;
}
