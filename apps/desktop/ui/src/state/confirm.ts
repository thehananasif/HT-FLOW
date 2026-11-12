/**
 * Confirmation prompts driven by Settings → General (confirmations) and Common settings
 * (trading → skip confirmations in tables, closing modules).
 *
 * `confirmAction(kind, …)` resolves true immediately when the setting says "do not ask", otherwise
 * it queues a dialog that `ConfirmHost` (mounted by the Settings module) renders.
 */
import { create } from 'zustand';
import { getSetting } from './settings';

export type ConfirmKind =
  /** Flatten all / Cancel all from a table, window or the palette. */
  | 'flatten'
  /** One order sent from the Trading panel, DOM or a chart. */
  | 'order'
  /** Closing / reversing one position or cancelling one order in a table row. */
  | 'tableAction'
  /** Closing a window. */
  | 'closeWindow';

export interface ConfirmContext {
  /** The window being closed is a module window (Settings → Common → Closing modules applies). */
  module?: boolean;
  /** The action starts from an Orders / Positions table (Settings → Common → skip in tables). */
  fromTable?: boolean;
}

/** True when the settings require a confirmation for this action. */
export function needsConfirm(kind: ConfirmKind, ctx: ConfirmContext = {}): boolean {
  switch (kind) {
    case 'flatten':
      return (
        getSetting('general.confirmFlatten') &&
        !(ctx.fromTable && getSetting('common.skipTableConfirmations'))
      );
    case 'order':
      return getSetting('general.confirmOrders');
    case 'tableAction':
      return !getSetting('common.skipTableConfirmations');
    case 'closeWindow':
      return (
        getSetting('general.confirmCloseWindow') &&
        !(ctx.module && getSetting('common.closeDontAsk'))
      );
  }
}

export interface ConfirmRequest {
  id: number;
  title: string;
  body: string;
  confirmLabel: string;
  danger: boolean;
  resolve(ok: boolean): void;
}

interface ConfirmStore {
  queue: ConfirmRequest[];
}

export const useConfirmStore = create<ConfirmStore>(() => ({ queue: [] }));

let nextId = 1;

export interface ConfirmText {
  title: string;
  body: string;
  confirmLabel?: string;
  danger?: boolean;
}

/** Always shows the dialog (for actions that must be confirmed regardless of settings). */
export function askConfirm(opts: ConfirmText): Promise<boolean> {
  return new Promise((resolve) => {
    const req: ConfirmRequest = {
      id: nextId++,
      title: opts.title,
      body: opts.body,
      confirmLabel: opts.confirmLabel ?? 'Confirm',
      danger: opts.danger ?? false,
      resolve: (ok) => {
        useConfirmStore.setState((s) => ({ queue: s.queue.filter((r) => r.id !== req.id) }));
        resolve(ok);
      },
    };
    useConfirmStore.setState((s) => ({ queue: [...s.queue, req] }));
  });
}

/** Resolves true when the action may proceed (no prompt needed, or the user confirmed). */
export async function confirmAction(
  kind: ConfirmKind,
  opts: ConfirmText,
  ctx: ConfirmContext = {},
): Promise<boolean> {
  if (!needsConfirm(kind, ctx)) return true;
  return askConfirm(opts);
}
