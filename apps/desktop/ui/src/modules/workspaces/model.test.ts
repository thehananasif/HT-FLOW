import { describe, expect, it } from 'vitest';
import { chartState, domState, type WorkspaceDoc } from '@htflow/workspace';
import { formatBytes, itemLabel, manageTree, removeWindowFromDoc, summarize } from './model';

function doc(): WorkspaceDoc {
  return {
    version: 1,
    name: 'D',
    activeTab: 'a',
    savedAt: 0,
    tabs: [
      {
        id: 'a',
        name: 'Main',
        layout: { grid: {}, panels: {} },
        tradingPanel: false,
        windows: {
          c1: chartState('mock:ESZ6', 'footprint', {
            ext: {
              drawings: { v: 1, items: [{ type: 'hline' }, { type: 'anchoredVwap' }] },
              indicators: { v: 1, items: [{ id: 'ema' }] },
            },
          }),
          c2: chartState('mock:NQZ6', 'liquidity-map'),
          d1: domState('mock:ESZ6'),
        },
      },
      {
        id: 'b',
        name: 'Second',
        layout: null,
        tradingPanel: false,
        windows: { m1: { kind: 'module', module: 'news' } },
      },
    ],
  };
}

describe('workspaces window model', () => {
  it('summarises a workspace', () => {
    const s = summarize(doc());
    expect(s).toMatchObject({
      layouts: 2,
      windows: 4,
      instruments: 2,
      charts: 2,
      doms: 1,
      modules: 1,
      heatmaps: 1,
      drawings: 2,
      indicators: 1,
      templates: ['Footprint', 'Liquidity Map'],
    });
    expect(s.bytes).toBeGreaterThan(100);
  });

  it('builds the manage tree with open / closed state and objects', () => {
    const { nodes, info } = manageTree(doc(), (w) => w.kind, new Set(['c1']));
    expect(nodes.map((n) => n.label)).toEqual(['Main (layout 1)', 'Second (layout 2)']);
    expect(info.get('t:a')!.detail).toBe('Count: 3');
    expect(info.get('w:a:c1')).toMatchObject({ open: true, detail: 'Opened' });
    expect(info.get('w:a:c2')).toMatchObject({ open: false, detail: 'Closed' });
    const c1 = nodes[0]!.children!.find((n) => n.id === 'w:a:c1')!;
    expect(c1.children![0]!.label).toBe('Objects list');
    expect(c1.children![0]!.children!.map((n) => n.label)).toEqual([
      'Hline',
      'Anchored Vwap',
      'Ema',
    ]);
    // Windows of another layout are never "open".
    expect(info.get('w:b:m1')!.open).toBe(false);
  });

  it('removes a window from a saved document and rebuilds its arrangement', () => {
    const next = removeWindowFromDoc(doc(), 'a', 'c2');
    const t = next.tabs[0]!;
    expect(Object.keys(t.windows)).toEqual(['c1', 'd1']);
    expect(t.layout).toBeNull();
    expect(t.specs!.map((s) => s.id)).toEqual(['c1', 'd1']);
  });

  it('formats labels and sizes', () => {
    expect(itemLabel({ name: 'my_line' })).toBe('My line');
    expect(itemLabel({})).toBe('Object');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.00 MB');
  });
});
