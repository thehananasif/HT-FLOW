import { create } from 'zustand';
import { ocoGroupId, type Order, type OrderRequest } from '@htflow/trading';
import { paper } from '../state/market';

/**
 * Trading Panel OCO (P17). While on, every resting order sent from the panel joins one group; the
 * first fill or cancel in the group cancels the others (paper engine user OCO groups). A group
 * that already fired is replaced by a fresh one, so the next orders start a new set.
 */
interface OcoState {
  enabled: boolean;
  group: string | null;
  setEnabled(v: boolean): void;
  newGroup(): void;
}

export const useOco = create<OcoState>((set) => ({
  enabled: false,
  group: null,
  setEnabled: (enabled) => set({ enabled, group: null }),
  newGroup: () => set({ group: null }),
}));

/** Orders of a group and whether it already fired (a member filled or was cancelled). */
export function ocoGroupState(group: string | null): { fired: boolean; working: Order[] } {
  if (!group) return { fired: false, working: [] };
  const members = [...paper.orders.values()].filter((o) => o.oco === group);
  return {
    fired: members.some((o) => o.filled > 0 || o.status === 'cancelled'),
    working: members.filter((o) => o.status === 'working' || o.status === 'partial'),
  };
}

/** Group id for the next order (none when OCO is off, or for market orders that fill at once). */
export function nextOcoGroup(type: OrderRequest['type']): string | undefined {
  const s = useOco.getState();
  if (!s.enabled || type === 'market') return undefined;
  if (s.group && !ocoGroupState(s.group).fired) return s.group;
  const group = ocoGroupId();
  useOco.setState({ group });
  return group;
}

/** Links the two newest working orders of an account / instrument as an OCO pair. */
export function linkLastTwo(accountId: string, instrumentId?: string): string | null {
  const orders = paper
    .workingOrders(accountId, instrumentId)
    .filter((o) => !o.parentId && o.filled === 0)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 2);
  return paper.linkOco(orders.map((o) => o.id));
}
