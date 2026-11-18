import { useEffect, useState, type ReactNode } from 'react';
import { toast } from '@htflow/ui-kit';
import { formatPrice } from '@htflow/market-data';
import type { Account, Fill, OptionPosition, Order, Position } from '@htflow/trading';
import { paper } from '../../state/market';
import { instrumentById } from '../../state/instruments';
import { DataTable, Pill, tableParams, type DataColumn } from '../../components/DataTable';
import { registerModule, type ModuleViewProps } from '../registry';
import { risk } from '../risk/engine';
import {
  exchangeTimeTitle,
  fmtClock,
  fmtMoney,
  maskAccount,
  privacyOptions,
  usePrivacy,
  useTimeFormat,
} from '../../state/format';
import { confirmAction } from '../../state/confirm';
import { editsStop, parseModify, type ModifyField } from './inlineModify';

import { translateLiteral as tl } from '@htflow/i18n';
/** Re-renders on every paper-engine event (fills land in all tables in the same frame). */
function useTicker(ms = 500) {
  useTimeFormat(); // times follow Settings → General / Time zones
  const [, set] = useState(0);
  useEffect(() => {
    const u = paper.subscribe(() => set((x) => x + 1));
    const i = setInterval(() => set((x) => x + 1), ms);
    return () => {
      u();
      clearInterval(i);
    };
  }, [ms]);
}

const px = (instrumentId: string, v: number | undefined) => {
  const i = instrumentById(instrumentId);
  return v === undefined || !i ? '—' : formatPrice(v, i);
};
const sym = (id: string) => instrumentById(id)?.symbol ?? id;
/** Account label: masked to the last four characters unless Settings → Privacy says otherwise. */
const accLabel = (id: string, name: string) => {
  const mask = privacyOptions().mask;
  const base = name.replace(/\s*·?\s*••••\w+$/, '');
  return `${base} ${mask ? maskAccount(id, true) : id}`.trim();
};
const accName = (id: string) => {
  const a = paper.accounts.get(id);
  return a ? accLabel(a.id, a.name) : maskAccount(id, privacyOptions().mask);
};
const masked = (a: Account) => accLabel(a.id, a.name);
const time = (t: number, ms = false) => fmtClock(t, { ms });
const money = (v: number) => fmtMoney(v);
const pnl = (v: number) => (
  <span className={v > 0 ? 'up' : v < 0 ? 'down' : 'muted'}>
    {v > 0 ? '+' : ''}
    {money(v)}
  </span>
);
const sidePill = (s: 'buy' | 'sell') => (
  <Pill tone={s === 'buy' ? 'up' : 'down'}>{s.toUpperCase()}</Pill>
);
const mark = (id: string) => {
  const m = paper.mark(id);
  return Number.isFinite(m) ? m : undefined;
};

function openPnl(accountId: string): number {
  // Options count at their mark-to-model P&L (P18).
  return paper.openPnl(accountId);
}

/* ------------------------------------------------------------------ Accounts */

const accountCols: DataColumn<Account>[] = [
  { id: 'account', header: 'Account', width: 1.4, mono: true, value: (a) => masked(a) },
  {
    id: 'connection',
    header: 'Connection',
    width: 1.1,
    value: (a) => (a.kind === 'paper' ? 'HT Sim' : a.kind === 'replay' ? 'Replay' : 'Broker'),
    render: (a) => (
      <span className="muted">
        {a.kind === 'paper' ? 'HT Sim' : a.kind === 'replay' ? 'Replay' : 'Broker'}
      </span>
    ),
  },
  {
    id: 'balance',
    header: 'Balance',
    align: 'right',
    value: (a) => a.balance,
    render: (a) => money(a.balance),
  },
  {
    id: 'equity',
    header: 'Equity',
    align: 'right',
    value: (a) => a.balance + openPnl(a.id),
    render: (a) => money(a.balance + openPnl(a.id)),
  },
  {
    id: 'open',
    header: 'Open P&L',
    width: 0.9,
    align: 'right',
    value: (a) => openPnl(a.id),
    render: (a) => pnl(openPnl(a.id)),
  },
  {
    id: 'day',
    header: 'Day P&L',
    width: 0.9,
    align: 'right',
    value: (a) => risk.status(a.id).dayPnl,
    render: (a) => pnl(risk.status(a.id).dayPnl),
  },
  {
    id: 'risk',
    header: 'Risk',
    width: 0.9,
    align: 'right',
    value: (a) => {
      const s = risk.status(a.id);
      return s.locked
        ? 'Locked'
        : s.usage >= 0.25
          ? `${Math.round(s.usage * 100)}% of limit`
          : 'OK';
    },
    render: (a) => {
      const s = risk.status(a.id);
      if (s.locked) return <Pill tone="down">{tl('Locked')}</Pill>;
      if (s.usage >= 0.25)
        return (
          <Pill tone={s.usage >= 0.8 ? 'down' : 'warning'}>
            {Math.round(s.usage * 100)}
            {tl('% of limit')}
          </Pill>
        );
      return <Pill tone="up">{tl('OK')}</Pill>;
    },
  },
  {
    id: 'currency',
    header: 'Currency',
    width: 0.6,
    defaultHidden: true,
    value: (a) => a.currency,
  },
];

function Accounts({ state, setParams }: ModuleViewProps) {
  useTicker();
  usePrivacy();
  const rows = [...paper.accounts.values()];
  const total = rows.reduce((s, a) => s + a.balance + openPnl(a.id), 0);
  return (
    <DataTable
      testId="accounts-table"
      title={tl('Accounts')}
      subtitle={`${rows.length} account${rows.length === 1 ? '' : 's'}`}
      rows={rows}
      columns={accountCols}
      rowKey={(a) => a.id}
      empty={tl('No accounts')}
      footer={
        <span>
          {tl('Total equity')} {money(total)}
        </span>
      }
      {...tableParams(state.params, setParams, accountCols)}
    />
  );
}

/* ------------------------------------------------------------------ Positions */

/** A futures position, or a paper options position (P18) when `option` is set. */
type PosRow = Position & { accountId: string; option?: OptionPosition };
const upnl = (p: PosRow) => {
  if (p.option) return paper.optionPnl(p.option);
  const m = mark(p.instrumentId);
  return m !== undefined ? paper.unrealized(p.accountId, p.instrumentId, m) : 0;
};
const optLabel = (o: OptionPosition) =>
  o.name ?? `${sym(o.underlyingId)} ${o.expiry} ${o.strike} ${o.right === 'call' ? 'C' : 'P'}`;
const optionRow = (o: OptionPosition): PosRow => ({
  instrumentId: optLabel(o),
  accountId: o.accountId,
  qty: o.qty,
  avgPx: o.avgPremium,
  realized: o.realized,
  option: o,
});
const premium = (v: number | undefined) =>
  v === undefined ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: 4 });
const markOf = (p: PosRow) => (p.option ? paper.optionMark(p.option) : mark(p.instrumentId));

const positionCols: DataColumn<PosRow>[] = [
  {
    id: 'instrument',
    header: 'Instrument',
    width: 1.1,
    mono: true,
    value: (p) => (p.option ? p.instrumentId : sym(p.instrumentId)),
    render: (p) =>
      p.option ? (
        <span title={tl('Paper option · premium per unit, marked to model')}>
          {p.instrumentId} <Pill tone="info">{tl('OPT')}</Pill>
        </span>
      ) : (
        sym(p.instrumentId)
      ),
  },
  {
    id: 'account',
    header: 'Account',
    width: 1.2,
    value: (p) => accName(p.accountId),
    render: (p) => <span className="muted">{accName(p.accountId)}</span>,
  },
  {
    id: 'side',
    header: 'Side',
    width: 0.7,
    value: (p) => (p.qty > 0 ? 'LONG' : 'SHORT'),
    render: (p) => <Pill tone={p.qty > 0 ? 'up' : 'down'}>{p.qty > 0 ? 'LONG' : 'SHORT'}</Pill>,
  },
  { id: 'qty', header: 'Qty', width: 0.6, align: 'right', value: (p) => Math.abs(p.qty) },
  {
    id: 'avg',
    header: 'Avg price',
    align: 'right',
    value: (p) => p.avgPx,
    render: (p) => (p.option ? premium(p.avgPx) : px(p.instrumentId, p.avgPx)),
  },
  {
    id: 'mark',
    header: 'Mark',
    align: 'right',
    value: (p) => markOf(p),
    render: (p) => (p.option ? premium(markOf(p)) : px(p.instrumentId, markOf(p))),
  },
  {
    id: 'open',
    header: 'Open P&L',
    align: 'right',
    value: (p) => upnl(p),
    render: (p) => <b>{pnl(upnl(p))}</b>,
  },
  {
    id: 'actions',
    header: '',
    width: 1.5,
    align: 'right',
    action: true,
    value: () => '',
    render: (p) => {
      const opt = p.option;
      if (opt)
        return (
          <button
            className="dt-cell-btn"
            data-testid="close-option-row"
            onClick={() =>
              void confirmAction(
                'tableAction',
                {
                  title: 'Close option',
                  body: `Close ${p.instrumentId} of ${accName(p.accountId)} at the model mark?`,
                  confirmLabel: 'Close option',
                  danger: true,
                },
                { fromTable: true },
              ).then((ok) => {
                if (!ok) return;
                const r = paper.closeOption(opt.id);
                if (typeof r === 'string') toast('error', tl('Could not close'), r);
              })
            }
          >
            {tl('Close')}
          </button>
        );
      return (
        <>
          <button
            className="dt-cell-btn"
            onClick={() =>
              void confirmAction(
                'tableAction',
                {
                  title: 'Close position',
                  body: `Close the ${sym(p.instrumentId)} position of ${accName(p.accountId)} at market?`,
                  confirmLabel: 'Close position',
                  danger: true,
                },
                { fromTable: true },
              ).then((ok) => ok && paper.flatten(p.accountId, p.instrumentId))
            }
          >
            {tl('Close')}
          </button>
          <button
            className="dt-cell-btn"
            onClick={() =>
              void confirmAction(
                'tableAction',
                {
                  title: 'Reverse position',
                  body: `Reverse the ${sym(p.instrumentId)} position of ${accName(p.accountId)} at market?`,
                  confirmLabel: 'Reverse',
                },
                { fromTable: true },
              ).then((ok) => ok && paper.reverse(p.accountId, p.instrumentId))
            }
          >
            {tl('Reverse')}
          </button>
        </>
      );
    },
  },
];

function Positions({ state, setParams }: ModuleViewProps) {
  useTicker();
  usePrivacy();
  const rows: PosRow[] = [...paper.allPositions(), ...paper.optionPositions().map(optionRow)];
  const net = rows.reduce((s, p) => s + upnl(p), 0);
  return (
    <DataTable
      testId="positions-table"
      title={tl('Positions')}
      subtitle={`${rows.length} open`}
      rows={rows}
      columns={positionCols}
      rowKey={(p) => (p.option ? p.option.id : `${p.accountId}|${p.instrumentId}`)}
      empty={tl('No open positions')}
      actions={
        <button
          className="dt-btn dt-btn--primary"
          onClick={() =>
            void confirmAction(
              'flatten',
              {
                title: 'Flatten all',
                body: 'Close every open position of every account at market and cancel their working orders?',
                confirmLabel: 'Flatten all',
                danger: true,
              },
              { fromTable: true },
            ).then((ok) => {
              if (!ok) return;
              for (const a of paper.accounts.keys()) paper.flattenAll(a);
              // Options close at their model mark (positions without a mark stay open).
              for (const o of paper.optionPositions()) paper.closeOption(o.id);
            })
          }
        >
          {tl('Flatten all')}
        </button>
      }
      footer={
        <span>
          Net open P&amp;L {pnl(net)} {tl('· Breakeven = H · Flatten all from the command palette')}
        </span>
      }
      {...tableParams(state.params, setParams, positionCols)}
    />
  );
}

/* ------------------------------------------------------------------ Orders */

const typeLabel = (o: Order) => {
  const t = o.type === 'stop-limit' ? 'Stop limit' : o.type[0]!.toUpperCase() + o.type.slice(1);
  return o.role && o.role !== 'entry' ? `${t} (${o.role.toUpperCase()})` : t;
};
const isWorking = (o: Order) => o.status === 'working' || o.status === 'partial';
const statusTone = (o: Order) =>
  o.status === 'filled'
    ? 'up'
    : o.status === 'rejected'
      ? 'down'
      : o.status === 'cancelled'
        ? 'muted'
        : 'info';

const EDIT_EVENT = 'ht-order-edit';
/** Starts inline editing of an order cell (Modify button, command palette). */
const requestEdit = (id: string, field: ModifyField) =>
  window.dispatchEvent(new CustomEvent(EDIT_EVENT, { detail: { id, field } }));

/**
 * Price / Qty cell of a working order: double-click (or Modify) to edit in place, Enter applies
 * through the paper engine's modify, Esc or leaving the cell cancels.
 */
function InlineEdit({ o, field, display }: { o: Order; field: ModifyField; display: ReactNode }) {
  const [text, setText] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  const inst = instrumentById(o.instrumentId);
  const working = isWorking(o);
  const initial = () => {
    if (field === 'qty') return String(o.qty);
    const cur = editsStop(o) ? o.stopPx : o.px;
    return cur === undefined || !inst ? '' : formatPrice(cur, inst);
  };
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ id: string; field: ModifyField }>).detail;
      if (d.id === o.id && d.field === field && working) {
        setBad(false);
        setText(initial());
      }
    };
    window.addEventListener(EDIT_EVENT, on);
    return () => window.removeEventListener(EDIT_EVENT, on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.id, field, working]);

  if (text === null || !working)
    return (
      <span
        className={working ? 'dt-editable' : undefined}
        title={working ? 'Double-click to edit, Enter applies' : undefined}
        data-testid={`order-${field}-${o.id}`}
        onDoubleClick={
          working
            ? (e) => {
                e.stopPropagation();
                setBad(false);
                setText(initial());
              }
            : undefined
        }
      >
        {display}
      </span>
    );
  const apply = () => {
    const ch = inst ? parseModify(o, inst.tickSize, field, text) : null;
    if (!ch) return setBad(true);
    if (!paper.modify(o.id, ch))
      toast('warning', tl('Order not modified'), tl('The engine rejected the new value.'));
    setText(null);
  };
  return (
    <input
      className="dt-inline-input tnum"
      aria-label={field === 'qty' ? 'Order quantity' : 'Order price'}
      aria-invalid={bad || undefined}
      data-testid={`order-${field}-input`}
      value={text}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => {
        setBad(false);
        setText(e.target.value);
      }}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => setText(null)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          apply();
        } else if (e.key === 'Escape') setText(null);
      }}
    />
  );
}

const orderCols: DataColumn<Order>[] = [
  {
    id: 'time',
    header: 'Time',
    width: 0.9,
    value: (o) => o.createdAt,
    render: (o) => (
      <span
        className="muted"
        title={exchangeTimeTitle(o.createdAt, instrumentById(o.instrumentId)?.assetClass)}
      >
        {time(o.createdAt)}
      </span>
    ),
  },
  {
    id: 'instrument',
    header: 'Instrument',
    width: 1.1,
    mono: true,
    value: (o) => sym(o.instrumentId),
  },
  { id: 'side', header: 'Side', width: 0.6, value: (o) => o.side, render: (o) => sidePill(o.side) },
  {
    id: 'type',
    header: 'Type',
    width: 0.9,
    value: typeLabel,
    render: (o) => (
      <>
        {o.oco && <span title={`OCO group ${o.oco}`}>⧉ </span>}
        {typeLabel(o)}
      </>
    ),
  },
  {
    id: 'qty',
    header: 'Qty',
    width: 0.7,
    align: 'right',
    value: (o) => o.qty,
    render: (o) => (
      <InlineEdit
        o={o}
        field="qty"
        display={o.filled && o.filled < o.qty ? `${o.filled}/${o.qty}` : o.qty}
      />
    ),
  },
  {
    id: 'price',
    header: 'Price',
    width: 0.9,
    align: 'right',
    value: (o) => o.px ?? o.stopPx ?? o.avgFillPx,
    render: (o) => (
      <InlineEdit
        o={o}
        field="price"
        display={px(
          o.instrumentId,
          o.px ?? o.stopPx ?? (o.status === 'filled' ? o.avgFillPx : undefined),
        )}
      />
    ),
  },
  {
    id: 'tif',
    header: 'TIF',
    width: 0.5,
    value: (o) => o.tif,
    render: (o) => <span className="muted">{o.tif}</span>,
  },
  {
    id: 'status',
    header: 'Status',
    width: 1.1,
    value: (o) => o.status,
    render: (o) => (
      <span title={o.reason}>
        <Pill tone={statusTone(o)}>
          {o.status === 'partial' ? 'Partial' : o.status[0]!.toUpperCase() + o.status.slice(1)}
        </Pill>
        {o.reason ? <span className="muted"> {o.reason}</span> : null}
      </span>
    ),
  },
  {
    id: 'oco',
    header: 'OCO group',
    width: 0.9,
    mono: true,
    defaultHidden: true,
    value: (o) => o.oco ?? '',
  },
  {
    id: 'account',
    header: 'Account',
    defaultHidden: true,
    value: (o) => accName(o.accountId),
  },
  { id: 'id', header: 'Order ID', mono: true, defaultHidden: true, value: (o) => o.id },
  {
    id: 'actions',
    header: '',
    width: 1.1,
    align: 'right',
    action: true,
    value: () => '',
    render: (o) =>
      isWorking(o) ? (
        <>
          <button className="dt-cell-btn" onClick={() => requestEdit(o.id, 'price')}>
            {tl('Modify')}
          </button>
          <button
            className="dt-cell-btn"
            aria-label={tl('Cancel order')}
            onClick={() =>
              void confirmAction(
                'tableAction',
                {
                  title: 'Cancel order',
                  body: `Cancel the working ${o.side} order on ${sym(o.instrumentId)}?`,
                  confirmLabel: 'Cancel order',
                },
                { fromTable: true },
              ).then((ok) => ok && paper.cancel(o.id))
            }
          >
            ✕
          </button>
        </>
      ) : null,
  },
];

function Orders({ state, setParams }: ModuleViewProps) {
  useTicker();
  usePrivacy();
  const rows = [...paper.orders.values()].sort(
    (a, b) => Number(isWorking(b)) - Number(isWorking(a)) || b.createdAt - a.createdAt,
  );
  const working = rows.filter(isWorking).length;
  return (
    <DataTable
      testId="orders-table"
      title={tl('Orders')}
      subtitle={`working ${working} · history`}
      rows={rows}
      columns={orderCols}
      rowKey={(o) => o.id}
      empty={tl('No orders yet')}
      actions={
        <button
          className="dt-btn dt-btn--primary"
          onClick={() =>
            void confirmAction(
              'flatten',
              {
                title: 'Cancel all orders',
                body: 'Cancel every working order of every account?',
                confirmLabel: 'Cancel all',
                danger: true,
              },
              { fromTable: true },
            ).then((ok) => ok && [...paper.accounts.keys()].forEach((a) => paper.cancelAll(a)))
          }
        >
          {tl('Cancel all')}
        </button>
      }
      footer={
        <span>
          {tl('OCO groups shown with ⧉ (☰ → Group by → OCO group) · drag on chart to modify')}
        </span>
      }
      {...tableParams(state.params, setParams, orderCols)}
    />
  );
}

/* ------------------------------------------------------------------ Trades */

const tradeCols: DataColumn<Fill>[] = [
  {
    id: 'time',
    header: 'Time',
    width: 1,
    value: (f) => f.ts,
    render: (f) => (
      <span
        className="muted"
        title={exchangeTimeTitle(f.ts, instrumentById(f.instrumentId)?.assetClass)}
      >
        {time(f.ts, true)}
      </span>
    ),
  },
  {
    id: 'instrument',
    header: 'Instrument',
    width: 1.1,
    mono: true,
    value: (f) => sym(f.instrumentId),
  },
  { id: 'side', header: 'Side', width: 0.6, value: (f) => f.side, render: (f) => sidePill(f.side) },
  { id: 'qty', header: 'Qty', width: 0.5, align: 'right', value: (f) => f.qty },
  {
    id: 'price',
    header: 'Price',
    width: 0.9,
    align: 'right',
    value: (f) => f.px,
    render: (f) => px(f.instrumentId, f.px),
  },
  {
    id: 'commission',
    header: 'Commission',
    width: 0.8,
    align: 'right',
    value: (f) => f.commission,
    render: (f) => <span className="muted">{money(-f.commission)}</span>,
  },
  {
    id: 'realized',
    header: 'Realized P&L',
    width: 0.9,
    align: 'right',
    value: (f) => f.realized,
    render: (f) => (f.realized === 0 ? <span className="muted">—</span> : <b>{pnl(f.realized)}</b>),
  },
  {
    id: 'order',
    header: 'Order ID',
    width: 1,
    mono: true,
    value: (f) => f.orderId,
    render: (f) => <span className="muted">{f.orderId}</span>,
  },
  {
    id: 'liquidity',
    header: 'Liquidity',
    width: 0.6,
    defaultHidden: true,
    value: (f) => f.liquidity,
  },
  { id: 'account', header: 'Account', defaultHidden: true, value: (f) => accName(f.accountId) },
];

function Trades({ state, setParams }: ModuleViewProps) {
  useTicker();
  usePrivacy();
  const rows = [...paper.fills].reverse();
  return (
    <DataTable
      testId="trades-table"
      title={tl('Trades')}
      subtitle={`${rows.length} fill${rows.length === 1 ? '' : 's'}`}
      rows={rows}
      columns={tradeCols}
      rowKey={(f) => f.id}
      empty={tl('No fills yet')}
      exportName="htflow-trades"
      footer={
        <span>{tl('Commission per account (paper: per-unit + taker fee) · ☰ → Export CSV')}</span>
      }
      {...tableParams(state.params, setParams, tradeCols)}
    />
  );
}

const wrap = (C: (p: ModuleViewProps) => JSX.Element) =>
  function ModuleTable(p: ModuleViewProps) {
    return (
      <div className="module-window">
        <C {...p} />
      </div>
    );
  };

registerModule({ id: 'accounts', view: wrap(Accounts) });
registerModule({ id: 'positions', view: wrap(Positions) });
registerModule({ id: 'orders', view: wrap(Orders) });
registerModule({ id: 'trades', view: wrap(Trades) });
