/** Pure helpers for the indicator right-click menu (P26: settings / hide / remove / move pane). */
import type { IndicatorConfig } from '@htflow/indicator-sdk';

export type PaneMove = 'overlay' | 'new' | 'up' | 'down';

/** Indicators shown in a sub-pane layer (`ind-pane:<leader uid>`): the leader and its joiners. */
export function indicatorsInPane(items: readonly IndicatorConfig[], layerId: string): string[] {
  if (!layerId.startsWith('ind-pane:')) return [];
  const leader = layerId.slice('ind-pane:'.length);
  return items.filter((c) => c.uid === leader || c.pane === leader).map((c) => c.uid);
}

/** Pane leaders (sub-pane indicators that open their own pane), in list order. */
function leaders(items: readonly IndicatorConfig[]): string[] {
  return items.filter((c) => c.pane === 'new').map((c) => c.uid);
}

/**
 * Moves an indicator: to the price pane (overlay), to its own new pane, or its pane one step up /
 * down among the stacked sub-panes (list order decides the stacking).
 */
export function moveIndicator(
  items: readonly IndicatorConfig[],
  uid: string,
  to: PaneMove,
): IndicatorConfig[] {
  const i = items.findIndex((c) => c.uid === uid);
  if (i < 0) return [...items];
  const cur = items[i]!;
  if (to === 'overlay' || to === 'new') {
    // Joiners of this indicator's pane open their own pane when the leader leaves.
    return items.map((c) =>
      c.uid === uid ? { ...c, pane: to, scale: 'own' } : c.pane === uid ? { ...c, pane: 'new' } : c,
    );
  }
  const leader = cur.pane === 'new' ? uid : cur.pane === 'overlay' ? null : cur.pane;
  if (!leader) return [...items];
  const order = leaders(items);
  const k = order.indexOf(leader);
  const j = to === 'up' ? k - 1 : k + 1;
  if (k < 0 || j < 0 || j >= order.length) return [...items];
  // Swap the two pane groups: rebuild the list with the groups exchanged.
  const a = order[Math.min(k, j)]!;
  const b = order[Math.max(k, j)]!;
  const groupOf = (l: string) => items.filter((c) => c.uid === l || c.pane === l);
  const ga = groupOf(a);
  const gb = groupOf(b);
  const inGroups = new Set([...ga, ...gb].map((c) => c.uid));
  const out: IndicatorConfig[] = [];
  let placed = false;
  for (const c of items) {
    if (!inGroups.has(c.uid)) out.push(c);
    else if (!placed) {
      out.push(...gb, ...ga);
      placed = true;
    }
  }
  return out;
}

/** Can the pane of `uid` move up / down? */
export function canMovePane(items: readonly IndicatorConfig[], uid: string, dir: 'up' | 'down') {
  const c = items.find((x) => x.uid === uid);
  if (!c || c.pane === 'overlay') return false;
  const leader = c.pane === 'new' ? uid : c.pane;
  const order = leaders(items);
  const k = order.indexOf(leader);
  return dir === 'up' ? k > 0 : k >= 0 && k < order.length - 1;
}
