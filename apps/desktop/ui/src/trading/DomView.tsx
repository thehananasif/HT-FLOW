import { useEffect, useMemo, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import { ChevronDown, Columns3, Crosshair, Lock, Pencil, StickyNote } from 'lucide-react';
import {
  COLUMN_DEFS,
  DomLadder,
  DomModel,
  moveColumn,
  orderPx,
  resizeColumn,
  toggleColumn,
  type DomColumnId,
  type DomTemplate,
} from '@htflow/dom';
import { formatPrice } from '@htflow/market-data';
import { DropdownMenu, SegmentedControl, Select, type MenuEntry } from '@htflow/ui-kit';
import type { DomWindowState } from '@htflow/workspace';
import { useWindows } from '../state/windows';
import { paper, pnlTick } from '../state/market';
import { effectiveMaxFps, frameInterval } from '../charts/settings/performance';
import { clickSide } from './dom/globalSettings';
import { getSettings, setSetting, useSettingsStore, type SettingsValues } from '../state/settings';
import { useAtmTemplates } from './atmStore';
import { setPrefs, tradingPrefs, useTradingPrefs } from './prefs';
import { usePaperTick } from './TradingPanel';
import { domActions } from './dom/actions';
import './trading.css';
import { useMarketStore } from '../charts/useMarket';
import { domStore, useDomStore } from './dom/store';
import { TemplateDesigner, openDesigner, useDesigner } from './dom/TemplateDesigner';
import { RiskStrip } from './dom/RiskStrip';
import { domControllers, smartDomExt, setWindowTemplate } from './dom/controllers';
import './dom/commands';
import './dom/dom.css';

type Drag =
  | { kind: 'resize'; id: DomColumnId; startX: number; startW: number; scale: number }
  | { kind: 'reorder'; id: DomColumnId; startX: number; x: number; moved: boolean }
  | { kind: 'order'; fromPx: number; toPx: number; moved: boolean }
  | null;

const SETTINGS_DEFAULT_ROW = 22;
const SETTINGS_DEFAULT_FONT = 12;
const SETTINGS_DEFAULT_RECENT = 30;

/**
 * Global Settings → DOM applied on top of the template: a non-default re-centre mode forces it,
 * a big-lot threshold fills in when the template has none, and a row height / font size changed
 * from its default overrides every template. Levels per side go to `ladder.maxLevels`.
 */
export function effectiveTemplate(t: DomTemplate, v: SettingsValues): DomTemplate {
  const style = { ...t.style };
  const behaviour = { ...t.behaviour };
  // The global mode only overrides the template once the user changed it from its default.
  const mode = v['dom.centerMode'];
  if (mode === 'off') style.centring = 'manual';
  else if (mode === 'always') style.centring = 'always';
  if (v['dom.rowHeight'] !== SETTINGS_DEFAULT_ROW) style.rowHeight = v['dom.rowHeight'];
  if (v['dom.fontSize'] !== SETTINGS_DEFAULT_FONT) style.fontSize = v['dom.fontSize'];
  if (v['dom.recentWindowSec'] !== SETTINGS_DEFAULT_RECENT)
    behaviour.recentSeconds = v['dom.recentWindowSec'];
  if (!behaviour.bigSize && v['dom.bigLotThreshold'] > 0)
    behaviour.bigSize = v['dom.bigLotThreshold'];
  return { ...t, style, behaviour };
}

/** Volume / Limit Δ column labels reflect the template's behaviour. */
function columnLabels(t: DomTemplate): Partial<Record<DomColumnId, string>> {
  const b = t.behaviour;
  return {
    volume: b.volumeScope === 'range' ? `Vol ${b.rangeMinutes}m` : 'Vol S',
    bidChg: `Δ ${b.limitSeconds}s`,
    askChg: `Δ ${b.limitSeconds}s`,
  };
}

/** Canvas Smart DOM ladder bound to a market store + paper engine (one-click trading, P15). */
function Ladder({
  instrumentId,
  lots,
  grouping,
  templateId,
  windowId,
}: {
  instrumentId: string;
  lots: number;
  grouping: number;
  templateId: string | undefined;
  windowId?: string;
}) {
  useDomStore();
  const raw = domStore.get(templateId);
  const settings = useSettingsStore((st) => st.values);
  const template = useMemo(() => effectiveTemplate(raw, settings), [raw, settings]);
  const store = useMarketStore(instrumentId);
  const ref = useRef<HTMLCanvasElement>(null);
  const ladder = useRef<DomLadder | null>(null);
  const model = useRef(new DomModel());
  const dirty = useRef(true);
  const lotsRef = useRef(lots);
  lotsRef.current = lots;
  // Edits (resize / reorder) apply to the stored template, not the settings-adjusted one.
  const tplRef = useRef(raw);
  tplRef.current = raw;
  const drag = useRef<Drag>(null);
  const [dropX, setDropX] = useState<number | null>(null);
  const [note, setNote] = useState<{ px: number; top: number; left: number; w: number } | null>(
    null,
  );
  const [layoutAttr, setLayoutAttr] = useState('');

  useEffect(() => {
    const c = ref.current!;
    const l = new DomLadder(c);
    l.autoFit = getSettings()['dom.autoFit'];
    l.setTemplate(effectiveTemplate(tplRef.current, getSettings()));
    l.labels = columnLabels(tplRef.current);
    l.maxLevels = getSettings()['common.domLevels'];
    const unSettings = useSettingsStore.subscribe((st, prev) => {
      if (st.values !== prev.values) {
        l.maxLevels = st.values['common.domLevels'];
        if (l.autoFit !== st.values['dom.autoFit']) {
          l.autoFit = st.values['dom.autoFit'];
          l.setTemplate(l.template);
          const r = c.parentElement!.getBoundingClientRect();
          l.resize(r.width, r.height);
        }
        dirty.current = true;
      }
    });
    ladder.current = l;
    const syncAttr = () =>
      setLayoutAttr(JSON.stringify({ header: l.headerHeight, row: l.rowHeight, cols: l.layout }));
    const ro = new ResizeObserver(() => {
      const r = c.parentElement!.getBoundingClientRect();
      l.resize(r.width, r.height);
      dirty.current = true;
      syncAttr();
    });
    ro.observe(c.parentElement!);
    let raf = 0;
    const unsub = store.subscribe(() => (dirty.current = true));
    const unsubPaper = paper.subscribe(() => (dirty.current = true));
    const unsubNotes = domStore.subscribe(() => (dirty.current = true));
    const unsubPrefs = tradingPrefs.subscribe(() => (dirty.current = true));
    let lastDraw = 0;
    // Draws at most once per animation frame, and only when something changed (or flashes fade).
    const frame = (ts: number) => {
      raf = requestAnimationFrame(frame);
      if (ts - lastDraw < frameInterval(effectiveMaxFps(0))) return;
      const animating =
        model.current.flashes.bid.size + model.current.flashes.ask.size > 0 || ts - lastDraw > 250;
      if ((!dirty.current && !animating) || !store.ready) return;
      dirty.current = false;
      lastDraw = ts;
      const now = store.lastTs || Date.now();
      const orders = domActions.orders(instrumentId);
      model.current.update(store.trades, store.book, now, orders);
      const d = drag.current;
      l.draw({
        book: store.book,
        model: model.current,
        instrument: store.instrument,
        lastPx: store.lastTrade?.px ?? Number.NaN,
        orders,
        position: domActions.position(instrumentId),
        pnlPerTick: pnlTick(instrumentId),
        notes: domStore.notes(instrumentId),
        now,
        drag: d?.kind === 'order' && d.moved ? { fromPx: d.fromPx, toPx: d.toPx } : null,
      });
    };
    raf = requestAnimationFrame(frame);
    const ctl = {
      recenter: () => {
        l.recenter();
        dirty.current = true;
      },
      scroll: (rows: number) => {
        l.scroll(rows);
        dirty.current = true;
      },
    };
    if (windowId) domControllers.set(windowId, ctl);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      unsub();
      unsubPaper();
      unsubNotes();
      unsubPrefs();
      unSettings();
      if (windowId && domControllers.get(windowId) === ctl) domControllers.delete(windowId);
    };
  }, [store, instrumentId, windowId]);

  // Template / behaviour changes.
  useEffect(() => {
    const l = ladder.current;
    if (!l) return;
    l.setTemplate(template);
    l.labels = columnLabels(template);
    const b = template.behaviour;
    model.current.configure({
      volumeScope: b.volumeScope,
      rangeMs: b.rangeMinutes * 60_000,
      recentWindowMs: b.recentSeconds * 1000,
      changeWindowMs: b.limitSeconds * 1000,
      pulledThreshold: b.pulledThreshold,
      stackedThreshold: b.stackedThreshold,
      flashMs: b.flashMs,
      icebergMinRefills: b.icebergMinRefills,
    });
    const r = ref.current?.parentElement?.getBoundingClientRect();
    if (r) l.resize(r.width, r.height);
    setLayoutAttr(JSON.stringify({ header: l.headerHeight, row: l.rowHeight, cols: l.layout }));
    dirty.current = true;
  }, [template]);

  useEffect(() => {
    model.current.reset();
    dirty.current = true;
  }, [instrumentId]);

  useEffect(() => {
    if (ladder.current) {
      ladder.current.grouping = grouping;
      ladder.current.recenter();
      dirty.current = true;
    }
  }, [grouping]);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const saveTemplate = (t: DomTemplate) => domStore.save(t);

  const place = (px: number, side: 'buy' | 'sell', stop: boolean) =>
    domActions.place({
      instrumentId,
      side,
      type: stop ? 'stop' : 'limit',
      qty: lotsRef.current,
      px,
    });

  const ordersAtPx = (px: number) => {
    const g = ladder.current?.grouping ?? 1;
    return domActions.orders(instrumentId).filter((o) => {
      const opx = orderPx(o);
      return opx !== undefined && Math.floor(opx / g) * g === px;
    });
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const l = ladder.current;
    if (!l || e.button !== 0) return;
    const { x, y } = local(e);
    const hh = l.headerHit(x, y);
    if (hh) {
      e.currentTarget.setPointerCapture(e.pointerId);
      const cfg = tplRef.current.columns.find((c) => c.id === hh.id)!;
      drag.current = hh.edge
        ? { kind: 'resize', id: hh.id, startX: x, startW: cfg.width, scale: l.widthScale }
        : { kind: 'reorder', id: hh.id, startX: x, x, moved: false };
      return;
    }
    const hit = l.hitTest(x, y);
    if (hit?.column === 'orders' && ordersAtPx(hit.px).length) {
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { kind: 'order', fromPx: hit.px, toPx: hit.px, moved: false };
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const l = ladder.current;
    const d = drag.current;
    const { x, y } = local(e);
    if (!l) return;
    if (!d) {
      const hh = l.headerHit(x, y);
      e.currentTarget.style.cursor = hh?.edge ? 'col-resize' : hh ? 'grab' : '';
      return;
    }
    if (d.kind === 'resize') {
      const w = d.startW + (x - d.startX) / Math.max(0.1, d.scale);
      l.setTemplate(resizeColumn(tplRef.current, d.id, w));
      dirty.current = true;
    } else if (d.kind === 'reorder') {
      d.x = x;
      if (Math.abs(x - d.startX) > 4) d.moved = true;
      if (d.moved) {
        const box = l.columnAtX(x);
        setDropX(box ? (x < box.x + box.w / 2 ? box.x : box.x + box.w) : null);
      }
    } else if (d.kind === 'order') {
      const hit = l.hitTest(Math.max(1, x), y);
      if (hit && hit.px !== d.toPx) {
        d.toPx = hit.px;
        d.moved = true;
        dirty.current = true;
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const l = ladder.current;
    const d = drag.current;
    drag.current = null;
    setDropX(null);
    if (!l || e.button !== 0) return;
    const { x, y } = local(e);
    if (d?.kind === 'resize') {
      saveTemplate(resizeColumn(tplRef.current, d.id, d.startW + (x - d.startX) / d.scale));
      return;
    }
    if (d?.kind === 'reorder') {
      if (!d.moved) return;
      const box = l.columnAtX(x);
      if (!box || box.id === d.id) return;
      const vis = l.layout.map((b) => b.id);
      const after = x >= box.x + box.w / 2;
      const target = after ? (vis[vis.indexOf(box.id) + 1] ?? null) : box.id;
      if (target === d.id) return;
      saveTemplate(moveColumn(tplRef.current, d.id, target));
      return;
    }
    if (d?.kind === 'order') {
      dirty.current = true;
      const os = ordersAtPx(d.fromPx);
      if (d.moved && d.toPx !== d.fromPx) {
        // Drag to modify: move every working order at the source price to the target price.
        for (const o of os) domActions.move(o, d.toPx + (orderPx(o)! - d.fromPx));
      } else os.forEach((o) => domActions.cancel(o));
      return;
    }
    const hit = l.hitTest(x, y);
    if (!hit) return;
    if (hit.column === 'notes') {
      const box = l.layout.find((b) => b.id === 'notes')!;
      setNote({
        px: hit.px,
        top: l.headerHeight + hit.row * l.rowHeight,
        left: box.x,
        w: Math.max(140, box.w),
      });
      return;
    }
    if (hit.column === 'bid' || hit.column === 'ask')
      place(hit.px, clickSide('left', getSettings()['dom.invertClicks']), e.ctrlKey);
  };

  const onContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const l = ladder.current;
    if (!l) return;
    const { x, y } = local(e);
    const hit = l.hitTest(x, y);
    if (hit && (hit.column === 'bid' || hit.column === 'ask'))
      place(hit.px, clickSide('right', getSettings()['dom.invertClicks']), e.ctrlKey);
  };

  return (
    <div className="dom-canvas-wrap" dir="ltr" data-notes={domStore.notes(instrumentId).size}>
      <canvas
        ref={ref}
        data-testid="dom-ladder"
        data-template={template.id}
        data-layout={layoutAttr}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={onContextMenu}
        onWheel={(e) => {
          ladder.current?.scroll(e.deltaY > 0 ? -3 : 3);
          dirty.current = true;
        }}
        onDoubleClick={() => {
          ladder.current?.recenter();
          dirty.current = true;
        }}
      />
      {dropX !== null && <div className="sdom-drop" style={{ left: dropX - 1 }} />}
      {note && (
        <NoteEditor
          key={note.px}
          label={formatPrice(note.px, store.instrument)}
          initial={domStore.notes(instrumentId).get(note.px) ?? ''}
          style={{
            top: note.top,
            left: note.left,
            width: note.w,
            height: template.style.rowHeight,
          }}
          onDone={(text) => {
            if (text !== null) domStore.setNote(instrumentId, note.px, text);
            setNote(null);
          }}
        />
      )}
    </div>
  );
}

function NoteEditor({
  label,
  initial,
  style,
  onDone,
}: {
  label: string;
  initial: string;
  style: React.CSSProperties;
  onDone: (text: string | null) => void;
}) {
  const [v, setV] = useState(initial);
  return (
    <input
      autoFocus
      className="sdom-note-input"
      data-testid="dom-note-input"
      aria-label={`Note at ${label}`}
      placeholder={`Note at ${label}`}
      style={style}
      value={v}
      maxLength={200}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onDone(v);
        if (e.key === 'Escape') onDone(null);
        e.stopPropagation();
      }}
      onBlur={() => onDone(v)}
    />
  );
}

/** Header of the Smart DOM window: template switcher, columns, volume scope, grouping, lots. */
function DomHeader({ id, s, template }: { id: string; s: DomWindowState; template: DomTemplate }) {
  const all = domStore.templates();
  const builtins = all.filter((t) => t.builtin);
  const custom = all.filter((t) => !t.builtin);
  const tplItems: MenuEntry[] = [
    ...builtins.map((t) => ({
      id: t.id,
      label: t.name,
      checked: t.id === template.id,
      onSelect: () => setWindowTemplate(id, t.id),
    })),
    ...(custom.length
      ? [
          { kind: 'separator' as const, id: 'sep-c' },
          { kind: 'label' as const, id: 'lbl-c', label: 'Custom' },
          ...custom.map((t) => ({
            id: t.id,
            label: t.name,
            checked: t.id === template.id,
            onSelect: () => setWindowTemplate(id, t.id),
          })),
        ]
      : []),
    { kind: 'separator', id: 'sep-n' },
    { id: 'new', label: 'New…', onSelect: () => openDesigner({ windowId: id, mode: 'new' }) },
    {
      id: 'edit',
      label: 'Edit current template…',
      onSelect: () => openDesigner({ windowId: id, templateId: template.id }),
    },
  ];
  const colItems: MenuEntry[] = COLUMN_DEFS.map((c) => {
    const cfg = template.columns.find((x) => x.id === c.id)!;
    return {
      id: c.id,
      label: c.id === 'bidChg' ? 'Limit Δ (bid)' : c.id === 'askChg' ? 'Limit Δ (ask)' : c.label,
      checked: cfg.visible,
      onSelect: () => domStore.save(toggleColumn(template, c.id)),
    };
  });
  const b = template.behaviour;
  const centerMode = useSettingsStore((st) => st.values['dom.centerMode']);
  const patch = (p: Partial<DomWindowState>) => useWindows.getState().patch(id, p);
  return (
    <div className="sdom-head" data-testid="dom-header">
      <DropdownMenu
        items={tplItems}
        trigger={
          <button className="sdom-hbtn" data-testid="dom-template-menu" title="DOM template">
            <span className="sdom-hbtn-k">Template:</span> {template.name}
            <ChevronDown size={12} />
          </button>
        }
      />
      <DropdownMenu
        items={colItems}
        trigger={
          <button className="sdom-hbtn" data-testid="dom-columns-menu" title="Columns">
            <Columns3 size={13} /> Columns
          </button>
        }
      />
      <SegmentedControl
        value={b.volumeScope}
        onChange={(v) => domStore.save({ ...template, behaviour: { ...b, volumeScope: v } })}
        options={[
          { value: 'session', label: 'Session', title: 'Volume / delta / VA for the session' },
          {
            value: 'range',
            label: `${b.rangeMinutes}m`,
            title: 'Volume / delta / VA for the rolling range',
          },
        ]}
      />
      <Select
        small
        aria-label="Price grouping"
        value={String(s.grouping)}
        onChange={(v) => patch({ grouping: Number(v) })}
        options={[1, 2, 5, 10].map((g) => ({
          value: String(g),
          label: `${g} tick${g > 1 ? 's' : ''}`,
        }))}
      />
      <div className="sdom-lots" role="group" aria-label="Lot presets">
        {b.lotPresets.map((q) => (
          <button
            key={q}
            className={`sdom-lot${s.lots === q ? ' on' : ''}`}
            onClick={() => patch({ lots: q })}
            title={`Trade ${q} lot${q > 1 ? 's' : ''}`}
          >
            {q}
          </button>
        ))}
      </div>
      <span className="grow" />
      <DropdownMenu
        items={(['off', 'out-of-view', 'always'] as const).map((m) => ({
          id: m,
          label: m === 'off' ? 'Off' : m === 'always' ? 'Always' : 'When out of view',
          checked: centerMode === m,
          onSelect: () => setSetting('dom.centerMode', m),
        }))}
        trigger={
          <button
            className="ht-icon-btn"
            aria-label="Re-centre mode"
            data-testid="dom-centre-mode"
            title="Re-centre on last price: off / when out of view / always"
          >
            <ChevronDown size={12} />
          </button>
        }
      />
      <button
        className="sdom-hbtn"
        data-testid="dom-recenter"
        aria-label="Re-centre"
        title="Re-centre on the last price (C)"
        onClick={() => domControllers.get(id)?.recenter()}
      >
        <Crosshair size={13} /> Re-centre
      </button>
      <button
        className="ht-icon-btn"
        aria-label="Clear notes"
        title="Clear all price notes for this instrument"
        onClick={() => domStore.clearNotes(s.instrumentId)}
      >
        <StickyNote size={13} />
      </button>
      <button
        className="ht-icon-btn"
        aria-label="Template designer"
        title="Template designer"
        onClick={() => openDesigner({ windowId: id, templateId: template.id })}
      >
        <Pencil size={13} />
      </button>
      {b.showRiskLimits && <RiskStrip instrumentId={s.instrumentId} />}
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
  useDomStore();
  const designer = useDesigner();
  const inst = s.instrumentId;
  const template = domStore.get(smartDomExt(s).template);
  const pos = domActions.position(inst);
  const account = domActions.account(inst);
  const upnl = pos.qty ? paper.unrealized(account, inst) : 0;
  const act = (fn: () => void) => () => fn();
  const market = (side: 'buy' | 'sell') =>
    domActions.place({ instrumentId: inst, side, type: 'market', qty: s.lots });
  return (
    <div
      className="dom-window"
      data-hotkey-scope="trading"
      onMouseDown={() => useWindows.getState().setActive(id)}
    >
      <DomHeader id={id} s={s} template={template} />
      <AtmStrip />
      <Ladder
        instrumentId={inst}
        lots={s.lots}
        grouping={s.grouping}
        templateId={template.id}
        windowId={id}
      />
      <div className="dom-foot-row">
        <button title="Reverse position" onClick={act(() => domActions.reverse(inst))}>
          × R
        </button>
        <button
          title="Open P&L of the position at the last price"
          disabled
          data-testid="dom-pnl"
          className={upnl > 0 ? 'up' : upnl < 0 ? 'down' : undefined}
        >
          {pos.qty ? `${upnl >= 0 ? '+' : '−'}${Math.abs(upnl).toFixed(2)}` : 'PnL'}
        </button>
        <button title="Cancel all orders" onClick={act(() => domActions.cancelAll(inst))}>
          ×
        </button>
        <button title="Buy market" onClick={act(() => market('buy'))}>
          MKT
        </button>
        <button title="Cancel buy orders" onClick={act(() => domActions.cancelAll(inst, 'buy'))}>
          ×
        </button>
        <button title="Cancel all orders" onClick={act(() => domActions.cancelAll(inst))}>
          ×
        </button>
        <button title="Sell market" onClick={act(() => market('sell'))}>
          MKT
        </button>
        <button title="Cancel sell orders" onClick={act(() => domActions.cancelAll(inst, 'sell'))}>
          ×
        </button>
        <button title="Cancel all orders" onClick={act(() => domActions.cancelAll(inst))}>
          ×
        </button>
      </div>
      <div className="dom-foot">
        <button
          className="ht-btn ht-btn--sm"
          title="Centre (C)"
          onClick={() => domControllers.get(id)?.recenter()}
        >
          C
        </button>
        <button
          className="ht-btn ht-btn--sm grow"
          onClick={() => domActions.flatten(inst)}
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
          onClick={() => domActions.toggleLock(inst)}
        >
          <Lock size={13} />
        </button>
      </div>
      {designer?.windowId === id && <TemplateDesigner />}
    </div>
  );
}

/** Compact DOM docked to the right of a chart (window bottom bar → DOM Trader). */
export function DomTrader({ instrumentId, lots }: { instrumentId: string; lots: number }) {
  return (
    <div className="dom-trader">
      <AtmStrip compact />
      <Ladder instrumentId={instrumentId} lots={lots} grouping={1} templateId="basic" />
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
