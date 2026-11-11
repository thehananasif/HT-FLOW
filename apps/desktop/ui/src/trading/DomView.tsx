import { useEffect, useRef } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import { Lock } from 'lucide-react';
import { DomLadder, DomModel, DEFAULT_COLUMNS, type DomColumnId } from '@htflow/dom';
import { Select, theme } from '@htflow/ui-kit';
import type { DomWindowState } from '@htflow/workspace';
import { useWindows } from '../state/windows';
import { paper, pnlTick } from '../state/market';
import { useMarketStore } from '../charts/useMarket';
import { activeAccount } from './accounts';
import { useAtmTemplates } from './atmStore';
import { cancelOrder, closePosition, reversePosition, submitOrder } from './orders';
import { setPrefs, tradingPrefs, useTradingPrefs } from './prefs';
import { usePaperTick } from './TradingPanel';
import './trading.css';

/** Account that trades `instrumentId` for the selected paper account (replay → replay account). */
const acct = (instrumentId: string) => paper.route(activeAccount(), instrumentId);

function domPalette() {
  const t = theme();
  return {
    bg: t.chartBg,
    surface1: t.surface1,
    surface2: t.surface2,
    surface3: t.surface3,
    divider: t.divider,
    border: t.border,
    textPrimary: t.textPrimary,
    textSecondary: t.textSecondary,
    textSoft: t.textSoft,
    up: t.up,
    down: t.down,
    info: t.info,
    volume: t.clusterStrong,
    warning: t.warning,
  };
}

/** Canvas DOM ladder bound to a market store + paper engine (one-click trading, P15). */
function Ladder({
  instrumentId,
  lots,
  grouping,
  columns,
}: {
  instrumentId: string;
  lots: number;
  grouping: number;
  columns?: DomColumnId[];
}) {
  const store = useMarketStore(instrumentId);
  const ref = useRef<HTMLCanvasElement>(null);
  const ladder = useRef<DomLadder | null>(null);
  const model = useRef(new DomModel());
  const lotsRef = useRef(lots);
  lotsRef.current = lots;

  useEffect(() => {
    const c = ref.current!;
    const l = new DomLadder(c, domPalette());
    if (columns)
      l.columns = DEFAULT_COLUMNS.map((d) => ({ ...d, visible: columns.includes(d.id) }));
    ladder.current = l;
    const ro = new ResizeObserver(() => {
      const r = c.parentElement!.getBoundingClientRect();
      l.resize(r.width, r.height);
    });
    ro.observe(c.parentElement!);
    let raf = 0;
    let dirty = true;
    const unsub = store.subscribe(() => (dirty = true));
    const unsubPaper = paper.subscribe(() => (dirty = true));
    const unsubPrefs = tradingPrefs.subscribe(() => (dirty = true));
    const frame = () => {
      raf = requestAnimationFrame(frame);
      if (!dirty || !store.ready) return;
      dirty = false;
      model.current.update(store.trades, store.book, store.lastTs || Date.now());
      l.palette = domPalette();
      l.draw({
        book: store.book,
        model: model.current,
        instrument: store.instrument,
        lastPx: store.lastTrade?.px ?? Number.NaN,
        orders: paper.workingOrders(acct(instrumentId), instrumentId),
        position: paper.position(acct(instrumentId), instrumentId),
        pnlPerTick: pnlTick(instrumentId),
      });
    };
    frame();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      unsub();
      unsubPaper();
      unsubPrefs();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, instrumentId]);

  useEffect(() => {
    if (ladder.current) {
      ladder.current.grouping = grouping;
      ladder.current.recenter();
    }
  }, [grouping]);

  const onClick = (e: React.MouseEvent, right: boolean) => {
    const l = ladder.current;
    if (!l) return;
    const r = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const hit = l.hitTest(e.clientX - r.left, e.clientY - r.top);
    if (!hit) return;
    if (hit.column === 'orders') {
      const os = paper
        .workingOrders(acct(instrumentId), instrumentId)
        .filter((o) => (o.type === 'limit' ? o.px : o.stopPx) === hit.px);
      os.forEach((o) => void cancelOrder(o));
      return;
    }
    if (hit.column !== 'bid' && hit.column !== 'ask') return;
    const side = right ? 'sell' : 'buy';
    const stop = e.ctrlKey;
    // One-click entries carry the selected ATM template when SL / TP is on.
    void submitOrder({
      instrumentId,
      side,
      type: stop ? 'stop' : 'limit',
      qty: lotsRef.current,
      px: stop ? undefined : hit.px,
      stopPx: stop ? hit.px : undefined,
    });
  };

  return (
    <div className="dom-canvas-wrap">
      <canvas
        ref={ref}
        data-testid="dom-ladder"
        onClick={(e) => onClick(e, false)}
        onContextMenu={(e) => {
          e.preventDefault();
          onClick(e, true);
        }}
        onWheel={(e) => {
          ladder.current?.scroll(e.deltaY > 0 ? -3 : 3);
        }}
        onDoubleClick={() => ladder.current?.recenter()}
      />
    </div>
  );
}

export function DomWindow(props: IDockviewPanelProps) {
  const id = props.api.id;
  const s = useWindows((st) => st.windows[id]) as DomWindowState | undefined;
  if (!s || s.kind !== 'dom') return null;
  return <DomWindowBody id={id} s={s} />;
}

function DomWindowBody({ id, s }: { id: string; s: DomWindowState }) {
  usePaperTick();
  const inst = s.instrumentId;
  const account = acct(inst);
  const pos = paper.position(account, inst);
  const act = (fn: () => void) => () => fn();
  const market = (side: 'buy' | 'sell') =>
    void submitOrder({ instrumentId: inst, side, type: 'market', qty: s.lots });
  return (
    <div className="dom-window" onMouseDown={() => useWindows.getState().setActive(id)}>
      <AtmStrip />
      <Ladder instrumentId={inst} lots={s.lots} grouping={s.grouping} />
      <div className="dom-foot-row">
        <button title="Reverse position" onClick={act(() => void reversePosition(inst))}>
          × R
        </button>
        <button title="Position PnL" disabled>
          PnL
        </button>
        <button title="Cancel all orders" onClick={act(() => paper.cancelAll(account, inst))}>
          ×
        </button>
        <button title="Buy market" onClick={act(() => market('buy'))}>
          MKT
        </button>
        <button
          title="Cancel buy orders"
          onClick={act(() => paper.cancelAll(account, inst, 'buy'))}
        >
          ×
        </button>
        <button title="Cancel all orders" onClick={act(() => paper.cancelAll(account, inst))}>
          ×
        </button>
        <button title="Sell market" onClick={act(() => market('sell'))}>
          MKT
        </button>
        <button
          title="Cancel sell orders"
          onClick={act(() => paper.cancelAll(account, inst, 'sell'))}
        >
          ×
        </button>
        <button title="Cancel all orders" onClick={act(() => paper.cancelAll(account, inst))}>
          ×
        </button>
      </div>
      <div className="dom-foot">
        <button
          className="ht-btn ht-btn--sm"
          title="Centre"
          onClick={() => useWindows.getState().patch(id, { grouping: s.grouping })}
        >
          C
        </button>
        <button
          className="ht-btn ht-btn--sm grow"
          onClick={() => (pos.qty ? void closePosition(inst) : paper.flattenAll(account))}
          disabled={!pos.qty && !paper.workingOrders(account).length}
        >
          Flatten all
        </button>
        <button
          className="ht-btn ht-btn--sm"
          onClick={() => useWindows.getState().setTradingPanel(!useWindows.getState().tradingPanel)}
        >
          Trading Panel
        </button>
        <button
          className="ht-icon-btn"
          aria-label="Lock trading"
          title="Lock trading"
          onClick={() => paper.setLocked(account, !paper.accounts.get(account)?.locked)}
        >
          <Lock size={13} />
        </button>
      </div>
    </div>
  );
}

/** Compact DOM docked to the right of a chart (window bottom bar → DOM Trader). */
export function DomTrader({ instrumentId, lots }: { instrumentId: string; lots: number }) {
  return (
    <div className="dom-trader">
      <AtmStrip compact />
      <Ladder
        instrumentId={instrumentId}
        lots={lots}
        grouping={1}
        columns={['orders', 'bid', 'price', 'ask']}
      />
    </div>
  );
}

/** SL / TP toggle + ATM template picker shared with the Trading Panel. */
function AtmStrip({ compact }: { compact?: boolean }) {
  const prefs = useTradingPrefs();
  const templates = useAtmTemplates();
  return (
    <div className="ot-dom-atm" data-testid="dom-atm">
      <label className="row gap6 center-y" title="Attach SL / TP to new orders">
        <input
          type="checkbox"
          checked={prefs.bracketOn}
          onChange={(e) => setPrefs({ bracketOn: e.target.checked })}
          aria-label="SL/TP on DOM orders"
        />
        {compact ? 'ATM' : 'SL/TP'}
      </label>
      <Select
        small
        value={templates.some((t) => t.id === prefs.atmId) ? prefs.atmId : ''}
        onChange={(v) => setPrefs({ atmId: v, bracketOn: true })}
        options={[
          { value: '', label: 'Custom' },
          ...templates.map((t) => ({ value: t.id, label: t.name })),
        ]}
        aria-label="DOM ATM template"
      />
    </div>
  );
}
