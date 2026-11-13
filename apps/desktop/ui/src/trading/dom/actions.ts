import type { Side } from '@htflow/market-data';
import type { Order } from '@htflow/trading';
import { paper } from '../../state/market';
import { activeAccount } from '../accounts';
import { cancelOrder, closePosition, moveOrder, reversePosition, submitOrder } from '../orders';

/**
 * The Smart DOM's only door to order handling. Every DOM action goes through here, so routing
 * (active account, replay account), ATM brackets and confirmations stay in `trading/orders.ts`.
 */
export const domActions = {
  /** Account that trades `instrumentId` for the selected account (replay → replay account). */
  account: (instrumentId: string): string => paper.route(activeAccount(), instrumentId),

  orders: (instrumentId: string): Order[] =>
    paper.workingOrders(domActions.account(instrumentId), instrumentId),

  position: (instrumentId: string) =>
    paper.position(domActions.account(instrumentId), instrumentId),

  /** One-click entry (limit / stop at a price, or market); attaches the ATM bracket when on. */
  place(req: {
    instrumentId: string;
    side: Side;
    type: 'limit' | 'stop' | 'market';
    qty: number;
    px?: number;
  }): void {
    void submitOrder({
      instrumentId: req.instrumentId,
      side: req.side,
      type: req.type,
      qty: req.qty,
      px: req.type === 'limit' ? req.px : undefined,
      stopPx: req.type === 'stop' ? req.px : undefined,
    }, { click: true });
  },

  cancel: (o: Order): void => void cancelOrder(o),

  /** Drag-to-modify (stop-limits keep their limit offset). */
  move: (o: Order, px: number): void => void moveOrder(o, px),

  cancelAll: (instrumentId: string, side?: Side): void =>
    void paper.cancelAll(domActions.account(instrumentId), instrumentId, side),

  /** Closes the position if any, otherwise cancels everything on the account. */
  flatten(instrumentId: string): void {
    const acc = domActions.account(instrumentId);
    if (paper.position(acc, instrumentId).qty) void closePosition(instrumentId);
    else paper.flattenAll(acc);
  },

  reverse: (instrumentId: string): void => void reversePosition(instrumentId),

  toggleLock(instrumentId: string): void {
    const acc = domActions.account(instrumentId);
    paper.setLocked(acc, !paper.accounts.get(acc)?.locked);
  },
};
