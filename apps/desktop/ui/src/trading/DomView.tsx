import { useEffect, useRef } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import { Lock } from 'lucide-react';
import { DomLadder, DomModel, DEFAULT_COLUMNS, type DomColumnId } from '@htflow/dom';
import { theme, toast } from '@htflow/ui-kit';
import type { DomWindowState } from '@htflow/workspace';
import { useWindows } from '../state/windows';
import { paper, PAPER_ACCOUNT, pnlTick } from '../state/market';
import { useMarketStore } from '../charts/useMarket';

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
        orders: paper.workingOrders(PAPER_ACCOUNT, instrumentId),
        position: paper.position(PAPER_ACCOUNT, instrumentId),
        pnlPerTick: pnlTick(instrumentId),
      });
    };
    frame();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      unsub();
      unsubPaper();
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
        .workingOrders(PAPER_ACCOUNT, instrumentId)
        .filter((o) => (o.px ?? o.stopPx) === hit.px);
      os.forEach((o) => paper.cancel(o.id));
      return;
    }
    if (hit.column !== 'bid' && hit.column !== 'ask') return;
    const side = right ? 'sell' : 'buy';
    const stop = e.ctrlKey;
    const o = paper.place({
      accountId: PAPER_ACCOUNT,
      instrumentId,
      side,
      type: stop ? 'stop' : 'limit',
      qty: lotsRef.current,
      px: stop ? undefined : hit.px,
      stopPx: stop ? hit.px : undefined,
    });
    if (o.status === 'rejected') toast('error', 'Order rejected', o.reason);
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
  const inst = s.instrumentId;
  const pos = paper.position(PAPER_ACCOUNT, inst);
  const act = (fn: () => void) => () => fn();
  return (
    <div className="dom-window" onMouseDown={() => useWindows.getState().setActive(id)}>
      <Ladder instrumentId={inst} lots={s.lots} grouping={s.grouping} />
      <div className="dom-foot-row">
        <button title="Reverse position" onClick={act(() => paper.reverse(PAPER_ACCOUNT, inst))}>
          × R
        </button>
        <button title="Position PnL" disabled>
          PnL
        </button>
        <button title="Cancel all orders" onClick={act(() => paper.cancelAll(PAPER_ACCOUNT, inst))}>
          ×
        </button>
        <button
          title="Buy market"
          onClick={act(() =>
            paper.place({
              accountId: PAPER_ACCOUNT,
              instrumentId: inst,
              side: 'buy',
              type: 'market',
              qty: s.lots,
            }),
          )}
        >
          MKT
        </button>
        <button
          title="Cancel buy orders"
          onClick={act(() => paper.cancelAll(PAPER_ACCOUNT, inst, 'buy'))}
        >
          ×
        </button>
        <button title="Cancel all orders" onClick={act(() => paper.cancelAll(PAPER_ACCOUNT, inst))}>
          ×
        </button>
        <button
          title="Sell market"
          onClick={act(() =>
            paper.place({
              accountId: PAPER_ACCOUNT,
              instrumentId: inst,
              side: 'sell',
              type: 'market',
              qty: s.lots,
            }),
          )}
        >
          MKT
        </button>
        <button
          title="Cancel sell orders"
          onClick={act(() => paper.cancelAll(PAPER_ACCOUNT, inst, 'sell'))}
        >
          ×
        </button>
        <button title="Cancel all orders" onClick={act(() => paper.cancelAll(PAPER_ACCOUNT, inst))}>
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
          onClick={() => paper.flattenAll(PAPER_ACCOUNT)}
          disabled={!pos.qty && !paper.workingOrders(PAPER_ACCOUNT).length}
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
          onClick={() => paper.setLocked(PAPER_ACCOUNT, !paper.accounts.get(PAPER_ACCOUNT)!.locked)}
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
      <Ladder
        instrumentId={instrumentId}
        lots={lots}
        grouping={1}
        columns={['orders', 'bid', 'price', 'ask']}
      />
    </div>
  );
}
