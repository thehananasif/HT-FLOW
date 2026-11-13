import { describe, expect, it } from 'vitest';
import { CATALOG, isImplemented, type CatalogEntry } from '@htflow/indicators';
import { buildIndicatorConfig } from './config';
import { indicatorPaletteItems } from './palette';

describe('indicator palette rows', () => {
  it('has one row per implemented catalog entry and none for pending ones', () => {
    const implemented = CATALOG.filter(isImplemented);
    const rows = indicatorPaletteItems(CATALOG, () => {});
    expect(rows).toHaveLength(implemented.length);
    expect(rows.every((r) => r.group === 'Indicators')).toBe(true);
    expect(rows.map((r) => r.id)).not.toContain(
      `indicator:${CATALOG.find((e) => !isImplemented(e))?.key}`,
    );
  });

  it('runs the add callback with the chosen catalog entry', () => {
    const picked: CatalogEntry[] = [];
    const rows = indicatorPaletteItems(CATALOG, (e) => picked.push(e));
    const first = CATALOG.find(isImplemented)!;
    rows.find((r) => r.id === `indicator:${first.key}`)!.run();
    expect(picked).toEqual([first]);
  });

  it('shows the category as the hint', () => {
    const rows = indicatorPaletteItems(CATALOG, () => {});
    const first = CATALOG.find(isImplemented)!;
    const row = rows.find((r) => r.id === `indicator:${first.key}`)!;
    expect(row.label).toBe(first.name);
    expect(row.hint).toBeTruthy();
  });
});

describe('buildIndicatorConfig (shared by the dialog and the palette)', () => {
  it('builds a config for an implemented entry, using its implementation id', () => {
    const e = CATALOG.find(isImplemented)!;
    const cfg = buildIndicatorConfig(e);
    expect(cfg).not.toBeNull();
    expect(cfg!.type).toBe(e.impl);
    expect(cfg!.uid).toBeTruthy();
  });

  it('returns null for a pending entry', () => {
    const pending = CATALOG.find((e) => !isImplemented(e));
    expect(pending).toBeDefined();
    expect(buildIndicatorConfig(pending!)).toBeNull();
  });
});
