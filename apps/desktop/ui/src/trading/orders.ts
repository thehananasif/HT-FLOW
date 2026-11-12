import { formatPrice, formatQty, type Instrument } from '@htflow/market-data';
import {
  atrTicks,
  resolveAtm,
  type AtmTemplate,
  type BracketSpec,
  type Order,
  type OrderRequest,
} from '@htflow/trading';
import { toast } from '@htflow/ui-kit';
import { hub, paper } from '../state/market';
import { instrumentById } from '../state/instruments';
import { activeAccount } from './accounts';
import { templateById } from './atmStore';
import { confirmAction } from './confirm';
import { tradingPrefs, type ConfirmKind, type TradingPrefs } from './prefs';

export function instrumentOf(id: string): Instrument | undefined {
  return hub.peek(id)?.instrument ?? instrumentById(id);
}

export function lastPx(instrumentId: string): number {
  const s = hub.peek(instrumentId);
  return s?.lastTrade?.px ?? s?.book.mid ?? Number.NaN;
}

/** ATR (ticks) over 1-minute bars of the instrument's session data. */
export function instrumentAtr(instrumentId: string, period = 14): number | undefined {
  const s = hub.peek(instrumentId);
  if (!s?.ready) return undefined;
  const a = atrTicks(s.getSeries({ kind: 'time', ms: 60_000 }).bars, period);
  return Number.isFinite(a) && a > 0 ? a : undefined;
}

/** The panel's custom SL / TP as a one-target template. */
export function customTemplate(p: TradingPrefs): AtmTemplate {
  return {
    id: '',
    name: 'Custom',
    sl: {
      enabled: true,
      type: p.slKind === 'atr' ? 'atr' : p.slKind === 'trailing' ? 'trailing' : 'ticks',
      value: p.sl,
      trailUnit: 'ticks',
    },
    tpUnit: p.tpUnit,
    targets: [{ value: p.tp, qty: 1 }],
    breakeven: { enabled: false, trigger: 1, offset: 0 },
    trailSteps: [],
    atrPeriod: 14,
  };
}

/** The template new entries use right now (selected ATM, or the custom SL / TP). */
export function currentTemplate(p = tradingPrefs.get()): AtmTemplate | null {
  if (!p.bracketOn) return null;
  return templateById(p.atmId) ?? customTemplate(p);
}

/** Resolves the current bracket for an entry at `refPx` (ticks). Throws a readable error. */
export function bracketFor(
  instrumentId: string,
  refPx: number,
  t = currentTemplate(),
): BracketSpec | undefined {
  if (!t) return undefined;
  const inst = instrumentOf(instrumentId);
  const econ = { tickSize: inst?.tickSize ?? 1, tickValue: inst?.tickValue ?? 0 };
  return resolveAtm(t, { econ, refPx, atrTicks: instrumentAtr(instrumentId, t.atrPeriod) });
}

export function confirmKindOf(req: Pick<OrderRequest, 'type' | 'displayQty'>): ConfirmKind {
  return req.displayQty ? 'iceberg' : req.type;
}

const TYPE_LABEL: Record<OrderRequest['type'], string> = {
  market: 'Market',
  limit: 'Limit',
  stop: 'Stop',
  'stop-limit': 'Stop limit',
  mit: 'MIT',
  'trailing-stop': 'Trailing stop',
};

export function orderTypeLabel(o: Pick<Order, 'type' | 'displayQty'>): string {
  return o.displayQty ? 'Iceberg' : TYPE_LABEL[o.type];
}

/** Short label used on chart lines and lists, e.g. "BUY LMT 2 @ 4521.25". */
export function orderLineLabel(o: Order, inst?: Instrument): string {
  const short: Record<Order['type'], string> = {
    market: 'MKT',
    limit: o.displayQty ? 'ICE' : 'LMT',
    stop: 'STP',
    'stop-limit': 'STP LMT',
    mit: 'MIT',
    'trailing-stop': 'TRAIL',
  };
  const role = o.role === 'sl' ? 'SL' : o.role === 'tp' ? 'TP' : o.side === 'buy' ? 'BUY' : 'SELL';
  const px = o.type === 'limit' || o.type === 'market' ? o.px : o.stopPx;
  const qty = formatQty(o.qty - o.filled, inst?.qtyPrecision ?? 0);
  const ice = o.displayQty ? ` (${formatQty(o.displayQty, inst?.qtyPrecision ?? 0)} shown)` : '';
  return `${role} ${short[o.type]} ${qty}${ice}${px !== undefined && inst ? ` @ ${formatPrice(px, inst)}` : ''}`;
}

function describe(req: OrderRequest, inst?: Instrument): string[] {
  const f = (px: number | undefined) => (px === undefined || !inst ? '—' : formatPrice(px, inst));
  const lines = [
    `${req.side === 'buy' ? 'Buy' : 'Sell'} ${formatQty(req.qty, inst?.qtyPrecision ?? 0)} ${inst?.symbol ?? req.instrumentId}`,
    `Type: ${orderTypeLabel({ type: req.type, displayQty: req.displayQty })}${req.tif ? ` · ${req.tif}` : ''}`,
  ];
  if (req.px !== undefined) lines.push(`Limit: ${f(req.px)}`);
  if (req.stopPx !== undefined)
    lines.push(`${req.type === 'mit' ? 'Trigger' : 'Stop'}: ${f(req.stopPx)}`);
  if (req.trail) lines.push(`Trail: ${req.trail.amount} ${req.trail.kind}`);
  if (req.displayQty) lines.push(`Display qty: ${req.displayQty}`);
  if (req.bracket) {
    const b = req.bracket;
    lines.push(
      `ATM ${b.atm ?? ''}: SL ${b.slTicks ?? '—'}T${b.slTrail ? ' trailing' : ''} · TP ${(b.tpTicks ?? []).join('/') || '—'}T`,
    );
  }
  lines.push(
    `Account: ${paper.accounts.get(paper.route(req.accountId, req.instrumentId))?.name ?? req.accountId}`,
  );
  return lines;
}

export interface SubmitOptions {
  /** Attach the current SL / TP (selected ATM template) to this entry. Default: prefs.bracketOn. */
  withBracket?: boolean;
  /** Skip the confirmation dialog (already confirmed elsewhere). */
  noConfirm?: boolean;
}

/**
 * Places an order from any trading surface (Trading Panel, DOM, chart): fills in the active
 * account, attaches the selected ATM bracket, asks for confirmation when enabled and reports
 * rejections. Resolves with the order, or null when cancelled / invalid.
 */
export async function submitOrder(
  req: Omit<OrderRequest, 'accountId'> & { accountId?: string },
  opts: SubmitOptions = {},
): Promise<Order | null> {
  const full: OrderRequest = { ...req, accountId: req.accountId ?? activeAccount() };
  const inst = instrumentOf(full.instrumentId);
  const prefs = tradingPrefs.get();
  const withBracket = opts.withBracket ?? prefs.bracketOn;
  if (withBracket && !full.bracket && !full.reduceOnly) {
    const ref =
      full.type === 'limit' || full.type === 'stop-limit'
        ? full.px!
        : (full.stopPx ?? lastPx(full.instrumentId));
    try {
      full.bracket = bracketFor(full.instrumentId, ref);
    } catch (e) {
      toast('error', 'SL / TP not attached', (e as Error).message);
      return null;
    }
  }
  if (
    full.type === 'trailing-stop' &&
    full.trail?.kind === 'atr' &&
    full.trail.atrTicks === undefined
  )
    full.trail = { ...full.trail, atrTicks: instrumentAtr(full.instrumentId) };
  if (!opts.noConfirm) {
    const ok = await confirmAction(confirmKindOf(full), 'Confirm order', describe(full, inst));
    if (!ok) return null;
  }
  const o = paper.place(full);
  if (o.status === 'rejected') toast('error', 'Order rejected', o.reason);
  return o;
}

/** Cancels one order (with confirmation when enabled). */
export async function cancelOrder(o: Order): Promise<boolean> {
  const ok = await confirmAction('cancel', 'Cancel order?', [
    orderLineLabel(o, instrumentOf(o.instrumentId)),
  ]);
  return ok && paper.cancel(o.id);
}

/** Moves an order to a new price (chart drag); stop-limits keep their limit offset. */
export async function moveOrder(o: Order, px: number): Promise<boolean> {
  const inst = instrumentOf(o.instrumentId);
  const usesStop = o.type !== 'limit' && o.type !== 'market';
  const from = usesStop ? o.stopPx : o.px;
  if (from === undefined || from === px) return false;
  const ok = await confirmAction('modify', 'Modify order?', [
    orderLineLabel(o, inst),
    `New price: ${inst ? formatPrice(px, inst) : px}`,
  ]);
  if (!ok) return false;
  const changes: { px?: number; stopPx?: number } = usesStop ? { stopPx: px } : { px };
  if (o.type === 'stop-limit' && o.px !== undefined && o.stopPx !== undefined)
    changes.px = o.px + (px - o.stopPx);
  return paper.modify(o.id, changes);
}

/** Flattens a position (✕ on the position line, Close button). */
export async function closePosition(
  instrumentId: string,
  accountId = activeAccount(),
): Promise<void> {
  const acc = paper.route(accountId, instrumentId);
  const p = paper.position(acc, instrumentId);
  const inst = instrumentOf(instrumentId);
  const ok = await confirmAction('close', 'Close position?', [
    `${inst?.symbol ?? instrumentId}: ${p.qty > 0 ? 'long' : p.qty < 0 ? 'short' : 'flat'} ${Math.abs(p.qty)}`,
    'Cancels working orders and closes at market.',
  ]);
  if (ok) paper.flatten(acc, instrumentId);
}

export async function reversePosition(
  instrumentId: string,
  accountId = activeAccount(),
): Promise<void> {
  const ok = await confirmAction('close', 'Reverse position?', [
    instrumentOf(instrumentId)?.symbol ?? instrumentId,
  ]);
  if (ok) paper.reverse(accountId, instrumentId);
}
