import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Eye, EyeOff, Settings2, X } from 'lucide-react';
import { Button, Checkbox, NumberInput, Select, Toggle } from '@htflow/ui-kit';
import { formatPrice, type Side } from '@htflow/market-data';
import { describeAtm, type OrderRequest, type TimeInForce } from '@htflow/trading';
import { hub, paper } from '../state/market';
import { activeInstrument, useWindows } from '../state/windows';
import { instrumentById } from '../state/instruments';
import { useSetting } from '../state/settings';
import { formatNumber, HIDDEN_MONEY, usePrivacy } from '../state/format';
import { parseQtyPresets, tifOf } from './globalSettings';
import { maskId, pickableAccounts, routedAccount, selectAccount } from './accounts';
import { useAtmTemplates } from './atmStore';
import {
  cancelOrder,
  closePosition,
  lastPx,
  orderLineLabel,
  reversePosition,
  submitOrder,
} from './orders';
import { setPrefs, useTradingPrefs, type SlKind, type TpUnit } from './prefs';
import { openTradingSetup } from './setupNav';
import { PanelResizeHandle } from './PanelResizeHandle';
import { panelWidthOf, usePanelWidths } from './panelWidth';
import { nextOcoGroup, ocoGroupState, useOco } from './oco';
import './trading.css';

import { translateLiteral as tl, tt } from '@htflow/i18n';
/** Local midnight (epoch ms): start of "today" for daily P&L. */
export function startOfLocalDay(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function usePaperTick() {
  const [, set] = useState(0);
  useEffect(() => {
    const u = paper.subscribe(() => set((x) => x + 1));
    const i = setInterval(() => set((x) => x + 1), 500);
    return () => {
      u();
      clearInterval(i);
    };
  }, []);
}

type EntryType = 'limit' | 'stop' | 'stop-limit' | 'mit' | 'trailing-stop' | 'iceberg';

const ENTRY_TYPES: { value: EntryType; label: string }[] = [
  { value: 'limit', label: 'Limit' },
  { value: 'stop', label: 'Stop' },
  { value: 'stop-limit', label: 'Stop-limit' },
  { value: 'mit', label: 'MIT (market-if-touched)' },
  { value: 'trailing-stop', label: 'Trailing stop' },
  { value: 'iceberg', label: 'Iceberg' },
];

const TP_UNITS: { value: TpUnit; label: string }[] = [
  { value: 'ticks', label: 'T' },
  { value: 'usd', label: '$' },
  { value: 'percent', label: '%' },
  { value: 'points', label: 'pt' },
];

const SL_KINDS: { value: SlKind; label: string }[] = [
  { value: 'ticks', label: 'Fixed' },
  { value: 'trailing', label: 'Trailing' },
  { value: 'atr', label: 'ATR ×' },
];

/** Account selector: paper accounts, masked ids, the routed account's balance. */
function AccountPicker({ instrumentId }: { instrumentId: string | null }) {
  const prefs = useTradingPrefs();
  const privacy = usePrivacy();
  const [showId, setShowId] = useState(!privacy.mask);
  useEffect(() => setShowId(!privacy.mask), [privacy.mask]);
  const accounts = pickableAccounts();
  const routed = routedAccount(instrumentId);
  const isRouted = routed.id !== prefs.activeAccount;
  const label = (a: { id: string; name: string }) =>
    `${a.name.replace(/\s*·\s*••••\w+$/, '')} · ${showId ? a.id : maskId(a.id)}`;
  return (
    <>
      <label className="tp-label">{tl('Account')}</label>
      <div className="row gap6">
        <Select
          className="grow"
          value={accounts.some((a) => a.id === prefs.activeAccount) ? prefs.activeAccount : ''}
          onChange={selectAccount}
          options={accounts.map((a) => ({ value: a.id, label: label(a) }))}
          aria-label={tl('Account')}
        />
        <button
          className="ht-icon-btn"
          aria-label={showId ? 'Hide account id' : 'Show account id'}
          onClick={() => setShowId((x) => !x)}
        >
          {showId ? <EyeOff size={13} /> : <Eye size={13} />}
        </button>
        <button
          className="ht-icon-btn"
          aria-label={tl('Manage paper accounts')}
          title={tl('Paper accounts…')}
          onClick={() => openTradingSetup('accounts')}
        >
          <Settings2 size={13} />
        </button>
      </div>
      <div className="ot-acct tnum" data-testid="account-balance" data-account={routed.id}>
        {isRouted && <span className="ot-badge ot-badge--special">{tl('Routed')}</span>}
        <span className="ot-acct-name">{isRouted ? routed.name : ''}</span>
        <span className="grow" />
        <b>
          {privacy.hide ? HIDDEN_MONEY : formatNumber(routed.balance, privacy.locale)}{' '}
          {routed.currency}
        </b>
      </div>
      <button className="ot-link" onClick={() => openTradingSetup('accounts')}>
        {tl('Connect an account…')}
      </button>
    </>
  );
}

/** Advanced order entry: limit / stop / stop-limit / MIT / trailing / iceberg. */
function OrderEntry({
  instrumentId,
  qty,
  tif,
  reduceOnly,
  ocoFor,
}: {
  instrumentId: string;
  qty: number;
  tif: TimeInForce;
  reduceOnly: boolean;
  ocoFor: (type: OrderRequest['type']) => string | undefined;
}) {
  const inst = instrumentById(instrumentId) ?? hub.peek(instrumentId)?.instrument;
  const tick = inst?.tickSize ?? 1;
  const prec = inst?.pricePrecision ?? 2;
  const defType = useSetting('trading.defaultOrderType');
  const [type, setType] = useState<EntryType>(defType === 'stop' ? 'stop' : 'limit');
  useEffect(() => setType(defType === 'stop' ? 'stop' : 'limit'), [defType]);
  const [limit, setLimit] = useState(Number.NaN);
  const [stop, setStop] = useState(Number.NaN);
  const [trail, setTrail] = useState(10);
  const [trailKind, setTrailKind] = useState<'ticks' | 'percent' | 'atr'>('ticks');
  const [display, setDisplay] = useState(1);
  const fillLast = () => {
    const l = lastPx(instrumentId);
    if (Number.isNaN(l)) return;
    setLimit(Number((l * tick).toFixed(prec)));
    setStop(Number((l * tick).toFixed(prec)));
  };
  // Prefill prices with the last trade when the instrument changes.
  useEffect(() => {
    setLimit(Number.NaN);
    setStop(Number.NaN);
  }, [instrumentId]);
  useEffect(() => {
    if (Number.isNaN(limit) || Number.isNaN(stop)) fillLast();
  });
  const needsLimit = type === 'limit' || type === 'stop-limit' || type === 'iceberg';
  const needsStop = type === 'stop' || type === 'stop-limit' || type === 'mit';
  const toTicks = (v: number) => Math.round(v / tick);
  const place = (side: Side) => {
    const req: Omit<OrderRequest, 'accountId'> = {
      instrumentId,
      side,
      type: type === 'iceberg' ? 'limit' : type,
      qty,
      tif,
      reduceOnly,
    };
    if (needsLimit) req.px = toTicks(limit);
    if (needsStop) req.stopPx = toTicks(stop);
    if (type === 'trailing-stop') req.trail = { kind: trailKind, amount: trail };
    if (type === 'iceberg') req.displayQty = display;
    const oco = ocoFor(req.type);
    if (oco) req.oco = oco;
    void submitOrder(req);
  };
  return (
    <div className="ot-entry" data-testid="order-entry">
      <div className="row gap6 center-y">
        <Select
          small
          className="grow"
          value={type}
          onChange={setType}
          options={ENTRY_TYPES}
          aria-label={tl('Order type')}
        />
        <button className="ht-chip" onClick={fillLast} title={tl('Set prices to the last trade')}>
          {tl('Last')}
        </button>
      </div>
      {needsStop && (
        <div className="ot-field">
          <span>{type === 'mit' ? 'Trigger' : 'Stop'}</span>
          <NumberInput
            value={Number.isNaN(stop) ? 0 : stop}
            onChange={setStop}
            step={tick}
            precision={prec}
            aria-label={type === 'mit' ? 'Trigger price' : 'Stop price'}
          />
        </div>
      )}
      {needsLimit && (
        <div className="ot-field">
          <span>{tl('Limit')}</span>
          <NumberInput
            value={Number.isNaN(limit) ? 0 : limit}
            onChange={setLimit}
            step={tick}
            precision={prec}
            aria-label={tl('Limit price')}
          />
        </div>
      )}
      {type === 'trailing-stop' && (
        <div className="ot-field">
          <span>{tl('Trail')}</span>
          <div className="row gap6">
            <NumberInput
              className="grow"
              value={trail}
              onChange={setTrail}
              step={trailKind === 'ticks' ? 1 : 0.1}
              min={trailKind === 'ticks' ? 1 : 0.1}
              aria-label={tl('Trail distance')}
            />
            <Select
              small
              value={trailKind}
              onChange={setTrailKind}
              options={[
                { value: 'ticks', label: 'T' },
                { value: 'percent', label: '%' },
                { value: 'atr', label: 'ATR' },
              ]}
              aria-label={tl('Trail unit')}
            />
          </div>
        </div>
      )}
      {type === 'iceberg' && (
        <div className="ot-field">
          <span>{tl('Show')}</span>
          <NumberInput
            value={display}
            onChange={setDisplay}
            min={inst && inst.qtyPrecision > 0 ? Math.pow(10, -inst.qtyPrecision) : 1}
            step={inst && inst.qtyPrecision > 0 ? Math.pow(10, -inst.qtyPrecision) : 1}
            unit="Lots"
            aria-label={tl('Display quantity')}
          />
        </div>
      )}
      <div className="tp-grid">
        <Button
          variant="buy-outline"
          size="sm"
          onClick={() => place('buy')}
          data-testid="place-buy"
        >
          {tl('BUY')} {type === 'iceberg' ? 'ICE' : type.toUpperCase().replace('-STOP', '')}
        </Button>
        <Button
          variant="sell-outline"
          size="sm"
          onClick={() => place('sell')}
          data-testid="place-sell"
        >
          {tl('SELL')} {type === 'iceberg' ? 'ICE' : type.toUpperCase().replace('-STOP', '')}
        </Button>
      </div>
    </div>
  );
}

/** Working orders of the routed account on this instrument (cancel with ✕). */
function WorkingOrders({ instrumentId, accountId }: { instrumentId: string; accountId: string }) {
  const inst = instrumentById(instrumentId) ?? hub.peek(instrumentId)?.instrument;
  const orders = paper.workingOrders(accountId, instrumentId);
  if (!orders.length) return null;
  return (
    <div className="ot-orders" data-testid="tp-orders">
      {orders.map((o) => (
        <div
          key={o.id}
          className={`ot-order ${o.role === 'sl' ? 'down' : o.role === 'tp' ? 'up' : o.side === 'buy' ? 'up' : 'down'}`}
          data-testid="tp-order"
          data-px={o.type === 'limit' ? o.px : o.stopPx}
          data-role={o.role ?? 'order'}
        >
          <span className="grow tnum">{orderLineLabel(o, inst)}</span>
          {o.oco && !o.parentId && (
            <span className="ot-badge" title={tt`OCO group ${o.oco}`} data-testid="tp-oco-badge">
              {tl('OCO')}
            </span>
          )}
          {o.atm && <span className="ot-badge">{o.atm}</span>}
          <button
            className="ot-x"
            aria-label={tl('Cancel order')}
            onClick={() => void cancelOrder(o)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

/** Right-side Trading Panel (P17, board 02). Toggle with T. */
export function TradingPanel() {
  usePaperTick();
  const width = panelWidthOf(usePanelWidths(), 'trading');
  useWindows((s) => s.activeId);
  useWindows((s) => s.windows);
  const prefs = useTradingPrefs();
  const templates = useAtmTemplates();
  const instrumentId = activeInstrument();
  const inst = instrumentId ? instrumentById(instrumentId) : undefined;
  const store = instrumentId ? hub.peek(instrumentId) : undefined;
  // Settings → Trading: default quantity, quick sizes and time in force (live).
  const defQty = useSetting('trading.defaultQty');
  const presetsRaw = useSetting('trading.qtyPresets');
  const defTif = useSetting('trading.defaultTif');
  const presets = useMemo(() => parseQtyPresets(presetsRaw), [presetsRaw]);
  const [qty, setQty] = useState(defQty);
  useEffect(() => setQty(defQty), [defQty]);
  const oco = useOco();
  const ocoState = ocoGroupState(oco.group);
  const ocoWorking = ocoState.fired ? 0 : ocoState.working.length;
  const [reduceOnly, setReduceOnly] = useState(false);
  const [tif, setTif] = useState<TimeInForce>(tifOf(defTif));
  useEffect(() => setTif(tifOf(defTif)), [defTif]);
  const acc = routedAccount(instrumentId);
  const pos = instrumentId ? paper.position(acc.id, instrumentId) : null;
  // Marks come from the engine (last trade it saw, else the store's last trade / mid).
  const upnl = instrumentId ? paper.unrealized(acc.id, instrumentId) : 0;
  const day = paper.pnlSummary(acc.id, startOfLocalDay());
  const cur = acc.currency === 'USD' ? '$' : acc.currency;
  const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}`;
  const template = templates.find((t) => t.id === prefs.atmId);
  const summary = useMemo(() => (template ? describeAtm(template) : ''), [template]);

  const send = (side: Side, type: OrderRequest['type'], px?: number) => {
    if (!instrumentId) return;
    const group = nextOcoGroup(type);
    void submitOrder({
      instrumentId,
      side,
      type,
      qty,
      px,
      tif,
      reduceOnly,
      ...(group ? { oco: group } : {}),
    });
  };
  const book = store?.book;

  return (
    <>
      <PanelResizeHandle panelId="trading" />
      <aside
        className="trading-panel"
        aria-label="Trading Panel"
        data-testid="trading-panel"
        data-hotkey-scope="trading"
        style={{ '--tp-width': `${width}px` } as CSSProperties}
      >
        <div className="tp-head">
          <h3>Trading Panel</h3>
          <span className="muted">T</span>
          <button
            className="ht-icon-btn"
            aria-label="Trading setup"
            title="ATM templates, accounts, confirmations, chart trading"
            onClick={() => openTradingSetup('atm')}
          >
            <Settings2 size={14} />
          </button>
          <button
            className="ht-icon-btn"
            aria-label="Close trading panel"
            onClick={() => useWindows.getState().setTradingPanel(false)}
          >
            <X size={14} />
          </button>
        </div>
        <AccountPicker instrumentId={instrumentId} />
        <div className="tp-inst muted">
          {inst ? `${inst.symbol} · ${inst.exchange}` : 'Select a chart or DOM window'}
        </div>
        <label className="tp-label">Qty</label>
        <NumberInput
          value={qty}
          onChange={setQty}
          step={inst && inst.qtyPrecision > 0 ? Math.pow(10, -inst.qtyPrecision) : 1}
          min={0}
          unit="Lots"
          aria-label="Quantity"
        />
        <div className="row gap6 wrap tp-presets">
          {presets.map((n) => (
            <button key={n} className="ht-chip" aria-pressed={qty === n} onClick={() => setQty(n)}>
              {n}
            </button>
          ))}
        </div>
        <fieldset className="tp-grid" disabled={!instrumentId || acc.locked}>
          <Button variant="buy" onClick={() => send('buy', 'market')} data-testid="buy-market">
            BUY MARKET
          </Button>
          <Button variant="sell" onClick={() => send('sell', 'market')} data-testid="sell-market">
            SELL MARKET
          </Button>
          <Button
            variant="buy-outline"
            size="sm"
            onClick={() => book && send('buy', 'limit', book.bestAsk)}
          >
            BUY ASK
          </Button>
          <Button
            variant="sell-outline"
            size="sm"
            onClick={() => book && send('sell', 'limit', book.bestAsk)}
          >
            SELL ASK
          </Button>
          <Button
            variant="buy-outline"
            size="sm"
            onClick={() => book && send('buy', 'limit', book.bestBid)}
          >
            BUY BID
          </Button>
          <Button
            variant="sell-outline"
            size="sm"
            onClick={() => book && send('sell', 'limit', book.bestBid)}
          >
            SELL BID
          </Button>
          <Button
            size="sm"
            onClick={() => instrumentId && paper.cancelAll(acc.id, instrumentId, 'buy')}
          >
            Cancel Bids
          </Button>
          <Button
            size="sm"
            onClick={() => instrumentId && paper.cancelAll(acc.id, instrumentId, 'sell')}
          >
            Cancel Asks
          </Button>
          <Button size="sm" onClick={() => instrumentId && paper.cancelAll(acc.id, instrumentId)}>
            Cancel All
          </Button>
          <Button
            size="sm"
            onClick={() => instrumentId && void reversePosition(instrumentId, acc.id)}
          >
            Reverse
          </Button>
          <Button
            size="sm"
            className="span2"
            onClick={() => instrumentId && paper.breakeven(acc.id, instrumentId)}
          >
            Breakeven (H)
          </Button>
          <Button
            variant="primary"
            className="span2"
            onClick={() => instrumentId && void closePosition(instrumentId, acc.id)}
            data-testid="close-position"
          >
            Close
          </Button>
        </fieldset>
        <div
          className={`tp-pnl ${upnl >= 0 ? 'up' : 'down'}`}
          data-testid="pnl"
          data-value={upnl.toFixed(2)}
          title="Open (unrealized) P&L of this instrument at the last price"
        >
          PnL {upnl >= 0 ? '+' : ''}
          {upnl.toFixed(2)} {cur}
        </div>
        <div className="tp-day tnum" data-testid="pnl-day">
          <span title="Gross realized P&L of today's fills on this account">
            <span className="muted">Realized</span>{' '}
            <b
              className={day.realized > 0 ? 'up' : day.realized < 0 ? 'down' : ''}
              data-testid="pnl-realized"
              data-value={day.realized.toFixed(2)}
            >
              {signed(day.realized)}
            </b>
          </span>
          <span title="Commissions and fees of today's fills">
            <span className="muted">Fees</span> <b>{day.fees.toFixed(2)}</b>
          </span>
          <span title="Realized − fees + open P&L of every position on this account">
            <span className="muted">Net</span>{' '}
            <b className={day.net > 0 ? 'up' : day.net < 0 ? 'down' : ''} data-testid="pnl-net">
              {signed(day.net)}
            </b>
          </span>
        </div>
        <div className="tp-grid">
          <div className="tp-stat">
            <span className="muted">{pos?.qty ? (pos.qty > 0 ? 'Long' : 'Short') : 'Flat'}</span>
            <b className="tnum" data-testid="position-qty">
              {pos?.qty ?? 0}
            </b>
          </div>
          <div className="tp-stat">
            <span className="muted">Entry</span>
            <b className="tnum">{pos && pos.qty && inst ? formatPrice(pos.avgPx, inst) : '—'}</b>
          </div>
        </div>
        <div className="row between center-y tp-row">
          <span title="One-cancels-other: resting orders placed while ticked form one group; the first fill or cancel cancels the others">
            <Checkbox checked={oco.enabled} onChange={oco.setEnabled} label="OCO" />
          </span>
          <Select
            small
            value={tif}
            onChange={setTif}
            options={(['GTC', 'DAY', 'IOC', 'FOK', 'GTD'] as TimeInForce[]).map((v) => ({
              value: v,
              label: v,
            }))}
            aria-label="Time in force"
          />
        </div>
        {oco.enabled && (
          <div className="row between center-y tp-row muted" data-testid="oco-status">
            <span>
              {ocoWorking === 0
                ? 'OCO: the next resting order starts a group'
                : `OCO group: ${ocoWorking} working · the next order joins`}
            </span>
            <button className="ht-chip" onClick={oco.newGroup} disabled={ocoWorking === 0}>
              New group
            </button>
          </div>
        )}
        <div className="tp-row">
          <Checkbox checked={reduceOnly} onChange={setReduceOnly} label="Reduce-Only" />
        </div>
        <div className="row between center-y tp-row tp-section">
          <b>Order</b>
        </div>
        {instrumentId && (
          <fieldset className="ot-fieldset" disabled={acc.locked}>
            <OrderEntry
              instrumentId={instrumentId}
              qty={qty}
              tif={tif}
              reduceOnly={reduceOnly}
              ocoFor={nextOcoGroup}
            />
          </fieldset>
        )}
        <div className="row between center-y tp-row tp-section">
          <b>SL/TP</b>
          <span className="row gap6 center-y muted">
            {prefs.bracketOn ? 'On' : 'Off'}{' '}
            <Toggle
              checked={prefs.bracketOn}
              onChange={(v) => setPrefs({ bracketOn: v })}
              label="SL/TP bracket"
            />
          </span>
        </div>
        <div className="row gap6 center-y">
          <Select
            small
            className="grow"
            value={template ? template.id : ''}
            onChange={(v) => setPrefs({ atmId: v })}
            options={[
              { value: '', label: 'Custom SL / TP' },
              ...templates.map((t) => ({ value: t.id, label: `ATM · ${t.name}` })),
            ]}
            aria-label="ATM template"
          />
          <button className="ht-chip" onClick={() => openTradingSetup('atm')}>
            Edit templates
          </button>
        </div>
        {template ? (
          <div className="ot-atm-summary muted tnum" data-testid="atm-summary">
            {summary}
          </div>
        ) : (
          <div className="tp-bracket ot-bracket">
            <span className="up">TP</span>
            <div className="row gap6">
              <NumberInput
                className="grow"
                value={prefs.tp}
                onChange={(v) => v > 0 && setPrefs({ tp: v })}
                min={prefs.tpUnit === 'ticks' ? 1 : 0.01}
                step={prefs.tpUnit === 'ticks' ? 1 : 0.25}
                aria-label="Take profit"
              />
              <Select
                small
                value={prefs.tpUnit}
                onChange={(v) => setPrefs({ tpUnit: v })}
                options={TP_UNITS}
                aria-label="Take profit unit"
              />
            </div>
            <span className="down">SL</span>
            <div className="row gap6">
              <NumberInput
                className="grow"
                value={prefs.sl}
                onChange={(v) => v > 0 && setPrefs({ sl: v })}
                min={prefs.slKind === 'atr' ? 0.1 : 1}
                step={prefs.slKind === 'atr' ? 0.1 : 1}
                unit={prefs.slKind === 'atr' ? 'ATR' : 'T'}
                aria-label="Stop loss"
              />
              <Select
                small
                value={prefs.slKind}
                onChange={(v) => setPrefs({ slKind: v })}
                options={SL_KINDS}
                aria-label="Stop loss type"
              />
            </div>
          </div>
        )}
        <div className="row between center-y tp-row tp-section">
          <span>Trading on chart</span>
          <Toggle
            checked={prefs.chart.enabled}
            onChange={(v) => setPrefs({ chart: { ...prefs.chart, enabled: v } })}
            label="Trading on chart"
          />
        </div>
        {instrumentId && <WorkingOrders instrumentId={instrumentId} accountId={acc.id} />}
        <div className="tp-foot muted tnum" data-testid="tp-foot">
          <span>
            Balance {acc.balance.toFixed(2)} {acc.currency}
          </span>
          <span>
            Equity {day.equity.toFixed(2)} {acc.currency}
          </span>
          <span title="Balance change since the account was reset (realized P&L after fees)">
            Since reset {signed(acc.balance - acc.startingBalance)}
          </span>
          {acc.locked && <span className="down">LOCKED</span>}
        </div>
      </aside>
    </>
  );
}
