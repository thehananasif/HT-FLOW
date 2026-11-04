import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Button, Checkbox, NumberInput, Select, Toggle, toast } from '@htflow/ui-kit';
import type { Side } from '@htflow/market-data';
import type { OrderRequest, TimeInForce } from '@htflow/trading';
import { hub, paper, PAPER_ACCOUNT } from '../state/market';
import { activeInstrument, useWindows } from '../state/windows';
import { instrumentById } from '../state/instruments';

function usePaperTick() {
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

/** Right-side Trading Panel (P17, board 02). Toggle with T. */
export function TradingPanel() {
  usePaperTick();
  useWindows((s) => s.activeId);
  useWindows((s) => s.windows);
  const instrumentId = activeInstrument();
  const inst = instrumentId ? instrumentById(instrumentId) : undefined;
  const store = instrumentId ? hub.peek(instrumentId) : undefined;
  const [qty, setQty] = useState(1);
  const [oco, setOco] = useState(false);
  const [reduceOnly, setReduceOnly] = useState(false);
  const [tif, setTif] = useState<TimeInForce>('GTC');
  const [bracket, setBracket] = useState(false);
  const [tp, setTp] = useState(10);
  const [sl, setSl] = useState(10);
  const [showId, setShowId] = useState(false);
  const acc = paper.accounts.get(PAPER_ACCOUNT)!;
  const pos = instrumentId ? paper.position(PAPER_ACCOUNT, instrumentId) : null;
  const mark = store?.lastTrade?.px ?? Number.NaN;
  const upnl =
    instrumentId && !Number.isNaN(mark) ? paper.unrealized(PAPER_ACCOUNT, instrumentId, mark) : 0;

  const send = (side: Side, type: OrderRequest['type'], px?: number) => {
    if (!instrumentId) return;
    const o = paper.place({
      accountId: PAPER_ACCOUNT,
      instrumentId,
      side,
      type,
      qty,
      px,
      tif,
      reduceOnly,
      bracket: bracket ? { slTicks: sl, tpTicks: [tp] } : undefined,
    });
    if (o.status === 'rejected') toast('error', 'Order rejected', o.reason);
  };
  const book = store?.book;

  return (
    <aside className="trading-panel" aria-label="Trading Panel" data-testid="trading-panel">
      <div className="tp-head">
        <h3>Trading Panel</h3>
        <span className="muted">T</span>
        <button
          className="ht-icon-btn"
          aria-label="Close trading panel"
          onClick={() => useWindows.getState().setTradingPanel(false)}
        >
          <X size={14} />
        </button>
      </div>
      <label className="tp-label">Account</label>
      <div className="row gap8">
        <Select
          className="grow"
          value={PAPER_ACCOUNT}
          onChange={() => {}}
          options={[{ value: PAPER_ACCOUNT, label: showId ? 'Paper · 00073505' : acc.name }]}
          aria-label="Account"
        />
        <button
          className="ht-icon-btn"
          aria-label="Show account id"
          onClick={() => setShowId((x) => !x)}
        >
          👁
        </button>
      </div>
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
        {[1, 2, 5, 10, 25].map((n) => (
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
          onClick={() => instrumentId && paper.cancelAll(PAPER_ACCOUNT, instrumentId, 'buy')}
        >
          Cancel Bids
        </Button>
        <Button
          size="sm"
          onClick={() => instrumentId && paper.cancelAll(PAPER_ACCOUNT, instrumentId, 'sell')}
        >
          Cancel Asks
        </Button>
        <Button
          size="sm"
          onClick={() => instrumentId && paper.cancelAll(PAPER_ACCOUNT, instrumentId)}
        >
          Cancel All
        </Button>
        <Button
          size="sm"
          onClick={() => instrumentId && paper.reverse(PAPER_ACCOUNT, instrumentId)}
        >
          Reverse
        </Button>
        <Button
          size="sm"
          className="span2"
          onClick={() => instrumentId && paper.breakeven(PAPER_ACCOUNT, instrumentId)}
        >
          Breakeven (H)
        </Button>
        <Button
          variant="primary"
          className="span2"
          onClick={() => instrumentId && paper.flatten(PAPER_ACCOUNT, instrumentId)}
          data-testid="close-position"
        >
          Close
        </Button>
      </fieldset>
      <div className={`tp-pnl ${upnl >= 0 ? 'up' : 'down'}`} data-testid="pnl">
        PnL {upnl >= 0 ? '+' : ''}${upnl.toFixed(2)}
      </div>
      <div className="tp-grid">
        <div className="tp-stat">
          <span className="muted">Position</span>
          <b className="tnum" data-testid="position-qty">
            {pos?.qty ?? 0}
          </b>
        </div>
        <div className="tp-stat">
          <span className="muted">Entry</span>
          <b className="tnum">
            {pos && pos.qty && inst
              ? (pos.avgPx * inst.tickSize).toFixed(inst.pricePrecision)
              : '—'}
          </b>
        </div>
      </div>
      <div className="row between center-y tp-row">
        <Checkbox checked={oco} onChange={setOco} label="OCO" />
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
      <div className="tp-row">
        <Checkbox checked={reduceOnly} onChange={setReduceOnly} label="Reduce-Only" />
      </div>
      <div className="row between center-y tp-row tp-section">
        <b>SL/TP</b>
        <span className="row gap6 center-y muted">
          {bracket ? 'On' : 'Off'}{' '}
          <Toggle checked={bracket} onChange={setBracket} label="SL/TP bracket" />
        </span>
      </div>
      <div className="tp-bracket">
        <span className="up">TP</span>
        <NumberInput value={tp} onChange={setTp} min={1} unit="T" aria-label="Take profit ticks" />
        <span className="down">SL</span>
        <NumberInput value={sl} onChange={setSl} min={1} unit="T" aria-label="Stop loss ticks" />
      </div>
      <div className="tp-foot muted tnum">
        Balance ${acc.balance.toFixed(2)} · Realized $
        {(acc.balance - acc.startingBalance).toFixed(2)}
        {acc.locked && <span className="down"> · LOCKED</span>}
      </div>
    </aside>
  );
}
