import { describe, expect, it } from 'vitest';
import type { ChartWindowState } from '@htflow/workspace';
import {
  MAX_SNAPSHOTS,
  addSnapshot,
  makeSnapshot,
  parseSnapshots,
  removeSnapshot,
  restorePatch,
} from './snapshots';

const chart = (over: Partial<ChartWindowState> = {}): ChartWindowState =>
  ({
    kind: 'chart',
    instrumentId: 'mock:BTCUSDT',
    template: 'footprint',
    timeframe: { kind: 'time', ms: 60_000 },
    footprintMode: 'bid-ask',
    link: 'none',
    lots: 1,
    minLots: 1,
    heatColumnMs: 1000,
    ext: { indicators: { v: 1, items: [] } },
    ...over,
  }) as unknown as ChartWindowState;

describe('chart snapshots', () => {
  it('copies the state (later edits do not leak in)', () => {
    const s = chart();
    const snap = makeSnapshot(s, 'BTCUSDT', Date.UTC(2026, 10, 12, 14, 5), 'a');
    (s.ext as Record<string, unknown>).indicators = 'changed';
    expect((snap.state.ext as Record<string, unknown>).indicators).toEqual({ v: 1, items: [] });
    expect(snap.name).toMatch(/^BTCUSDT · \d+ Nov \d\d:\d\d$/);
  });

  it('adds newest first, replaces by id, caps the list, removes', () => {
    let list = addSnapshot([], makeSnapshot(chart(), 'A', 1, 'a'));
    list = addSnapshot(list, makeSnapshot(chart(), 'B', 2, 'b'));
    expect(list.map((x) => x.id)).toEqual(['b', 'a']);
    list = addSnapshot(list, makeSnapshot(chart(), 'A2', 3, 'a'));
    expect(list.map((x) => x.id)).toEqual(['a', 'b']);
    for (let i = 0; i < MAX_SNAPSHOTS + 5; i++)
      list = addSnapshot(list, makeSnapshot(chart(), 'x', i, `x${i}`));
    expect(list).toHaveLength(MAX_SNAPSHOTS);
    expect(removeSnapshot(list, 'x44').some((x) => x.id === 'x44')).toBe(false);
  });

  it('restores everything but the link group', () => {
    const snap = makeSnapshot(chart({ template: 'candles-vp', link: 'red' }), 'A', 1, 'a');
    const out = restorePatch(chart({ link: 'blue' }), snap);
    expect(out.template).toBe('candles-vp');
    expect(out.link).toBe('blue');
  });

  it('drops malformed stored entries', () => {
    const good = makeSnapshot(chart(), 'A', 1, 'a');
    expect(parseSnapshots([good, { id: 'x' }, null, 3])).toHaveLength(1);
    expect(parseSnapshots('nope')).toEqual([]);
  });
});
