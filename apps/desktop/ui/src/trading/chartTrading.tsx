import { useEffect, useRef } from 'react';
import { tradingDefaults } from './globalSettings';
import type { ChartLayer, ChartView, PointerHandler } from '@htflow/chart-engine';
import { formatPrice, formatQty, type Bar } from '@htflow/market-data';
import type { Fill, Order } from '@htflow/trading';
import type { MenuEntry } from '@htflow/ui-kit';
import type { ChartWindowState } from '@htflow/workspace';
import { registerChartExtension, type ChartExtensionContext } from '../charts/extensions';
import { paper } from '../state/market';
import { activeAccount } from './accounts';
import { cancelOrder, closePosition, moveOrder, orderLineLabel, submitOrder } from './orders';
import { tradingPrefs, type ChartTradingPrefs } from './prefs';

/**
 * Trading on chart (P17): position line with avg price, qty and live P&L and a ✕ to close;
 * working order lines (drag to modify, ✕ to cancel); SL / TP bracket lines (draggable);
 * B / S fill markers on bars. Registered through registerChartExtension, so ChartWindow is
 * untouched.
 */

export const EXT_ID = 'chart-trading';

export type LineKind = 'position' | 'order' | 'sl' | 'tp';

/** Geometry of one drawn line (canvas CSS px), exposed for hit-testing and tests. */
export interface LineGeom {
  kind: LineKind;
  id: string;
  px: number;
  y: number;
  /** ✕ handle box. */
  x0: number;
  x1: number;
  /** Label box (left edge → right edge incl. ✕). */
  lx0: number;
  lx1: number;
  label: string;
}

interface WinState {
  ctx: ChartExtensionContext;
  lines: LineGeom[];
  lastY: number | null;
  drag: { id: string; px: number; startY: number; moved: boolean } | null;
  pressX: { kind: LineKind; id: string } | null;
  hover: string | null;
  probe: HTMLElement | null;
  probeJson: string;
}

const wins = new Map<string, WinState>();

const HIT = 5;
const X_W = 16;

function chartPrefs(): ChartTradingPrefs {
  return tradingPrefs.get().chart;
}

function colors(v: ChartView, p: ChartTradingPrefs) {
  return {
    buy: p.buyColor || v.palette.up,
    sell: p.sellColor || v.palette.down,
    sl: p.slColor || v.palette.down,
    tp: p.tpColor || v.palette.up,
    pos: p.positionColor || v.palette.info,
  };
}

const priceOf = (o: Order) => (o.type === 'limit' || o.type === 'market' ? o.px : o.stopPx);

function dash(ctx: CanvasRenderingContext2D, style: ChartTradingPrefs['lineStyle'], w: number) {
  ctx.setLineDash(style === 'dashed' ? [6 * w, 4 * w] : style === 'dotted' ? [w, 3 * w] : []);
}

/** Index of the bar containing time `t` (last bar with open <= t), or -1. */
export function barIndexAt(bars: readonly Pick<Bar, 't'>[], t: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  if (hi < 0 || t < bars[0]!.t) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bars[mid]!.t <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

class TradingLayer implements ChartLayer {
  readonly id = 'chart-trading';
  constructor(private w: WinState) {}

  draw(v: ChartView): void {
    const w = this.w;
    const p = chartPrefs();
    w.lines = [];
    if (!p.enabled) {
      this.publish(v);
      return;
    }
    const instId = w.ctx.store.instrument.id;
    const inst = w.ctx.store.instrument;
    const acc = paper.route(activeAccount(), instId);
    const c = colors(v, p);
    const { ctx } = v;
    ctx.save();
    ctx.beginPath();
    ctx.rect(v.plot.x, v.plot.y, v.plot.w, v.plot.h);
    ctx.clip();

    if (p.showFills) this.drawFills(v, acc, instId, c, p);

    const pos = paper.position(acc, instId);
    const td = tradingDefaults();
    if (p.showPosition && td.showPositionLine && pos.qty !== 0) {
      const last = w.ctx.store.lastTrade?.px;
      const pnl = last !== undefined ? paper.unrealized(acc, instId, last) : 0;
      const side = pos.qty > 0 ? 'LONG' : 'SHORT';
      const cur = paper.accounts.get(acc)?.currency ?? 'USD';
      const pnlText = p.showPnl
        ? `  ${pnl >= 0 ? '+' : '−'}${Math.abs(pnl).toFixed(2)} ${cur === 'USD' ? '$' : cur}`
        : '';
      const label = `${side} ${formatQty(Math.abs(pos.qty), inst.qtyPrecision)} @ ${formatPrice(pos.avgPx, inst)}${pnlText}`;
      this.line(v, {
        kind: 'position',
        id: 'position',
        px: pos.avgPx,
        color: c.pos,
        label,
        labelColor: p.showPnl ? (pnl >= 0 ? v.palette.up : v.palette.down) : c.pos,
        solid: true,
      });
    }
    for (const o of paper.workingOrders(acc, instId)) {
      const bracket = o.role === 'sl' || o.role === 'tp';
      if (!td.showOrderLines || (bracket ? !p.showBrackets : !p.showOrders)) continue;
      const base = priceOf(o);
      if (base === undefined) continue;
      const dragging = w.drag?.id === o.id;
      const px = dragging ? w.drag!.px : base;
      const color =
        o.role === 'sl' ? c.sl : o.role === 'tp' ? c.tp : o.side === 'buy' ? c.buy : c.sell;
      let label = orderLineLabel(o, inst);
      if (dragging && px !== base) label += ` → ${formatPrice(px, inst)}`;
      this.line(v, {
        kind: o.role === 'sl' ? 'sl' : o.role === 'tp' ? 'tp' : 'order',
        id: o.id,
        px,
        color,
        label,
        labelColor: color,
        solid: false,
        dragging,
      });
      if (o.type === 'stop-limit' && o.px !== undefined && !dragging) {
        // Limit leg of a stop-limit as a faint companion line.
        const y = Math.round(v.yOf(o.px)) + 0.5;
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = p.lineWidth;
        dash(ctx, 'dotted', p.lineWidth);
        ctx.beginPath();
        ctx.moveTo(v.plot.x, y);
        ctx.lineTo(v.plot.x + v.plot.w, y);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);
      }
    }
    ctx.restore();
    const last = w.ctx.store.lastTrade?.px;
    w.lastY = last !== undefined ? v.yOf(last) : null;
    this.publish(v);
  }

  private line(
    v: ChartView,
    o: {
      kind: LineKind;
      id: string;
      px: number;
      color: string;
      label: string;
      labelColor: string;
      solid: boolean;
      dragging?: boolean;
    },
  ): void {
    const p = chartPrefs();
    const { ctx } = v;
    if (o.px < v.priceMin || o.px > v.priceMax) return;
    const y = Math.round(v.yOf(o.px)) + 0.5;
    const hovered = this.w.hover === o.id;
    ctx.strokeStyle = o.color;
    ctx.lineWidth = p.lineWidth + (hovered || o.dragging ? 1 : 0);
    dash(ctx, o.solid ? 'solid' : p.lineStyle, p.lineWidth);
    ctx.beginPath();
    ctx.moveTo(v.plot.x, y);
    ctx.lineTo(v.plot.x + v.plot.w, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = v.font(11, 600);
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(o.label).width;
    const h = 18;
    const bw = tw + 12 + X_W;
    const lx0 =
      p.labelSide === 'left' ? v.plot.x + 8 : Math.max(v.plot.x + 8, v.plot.x + v.plot.w - bw - 8);
    const top = y - h / 2;
    ctx.fillStyle = v.palette.surface3;
    ctx.globalAlpha = 0.95;
    ctx.fillRect(lx0, top, bw, h);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = o.color;
    ctx.lineWidth = 1;
    ctx.strokeRect(lx0 + 0.5, top + 0.5, bw - 1, h - 1);
    ctx.fillStyle = o.color;
    ctx.fillRect(lx0, top, 3, h);
    ctx.fillStyle = o.labelColor;
    ctx.fillText(o.label, lx0 + 8, y);
    // ✕ handle
    const x0 = lx0 + bw - X_W;
    ctx.strokeStyle = v.palette.divider;
    ctx.beginPath();
    ctx.moveTo(x0 + 0.5, top + 2);
    ctx.lineTo(x0 + 0.5, top + h - 2);
    ctx.stroke();
    ctx.fillStyle = v.palette.textSecondary;
    ctx.font = v.font(10, 600);
    ctx.textAlign = 'center';
    ctx.fillText('✕', x0 + X_W / 2, y + 0.5);
    ctx.textAlign = 'left';
    v.tags.push({ px: o.px, bg: o.color, fg: '#000' });
    this.w.lines.push({
      kind: o.kind,
      id: o.id,
      px: o.px,
      y,
      x0,
      x1: x0 + X_W,
      lx0,
      lx1: lx0 + bw,
      label: o.label,
    });
  }

  private drawFills(
    v: ChartView,
    acc: string,
    instId: string,
    c: ReturnType<typeof colors>,
    p: ChartTradingPrefs,
  ): void {
    const series = this.w.ctx.series();
    if (!series || !series.bars.length || p.maxMarkers <= 0) return;
    const bars = series.bars;
    const { ctx } = v;
    const s = p.markerSize;
    let drawn = 0;
    for (let i = paper.fills.length - 1; i >= 0 && drawn < p.maxMarkers; i--) {
      const f: Fill = paper.fills[i]!;
      if (f.instrumentId !== instId || f.accountId !== acc) continue;
      const bi = barIndexAt(bars, f.ts);
      if (bi < v.i0 || bi > v.i1) {
        if (bi >= 0 && bi < v.i0) break; // older fills are further left
        continue;
      }
      drawn++;
      const x = v.xOf(bi);
      const y = v.yOf(f.px);
      const buy = f.side === 'buy';
      ctx.fillStyle = buy ? c.buy : c.sell;
      ctx.beginPath();
      if (buy) {
        ctx.moveTo(x, y + 2);
        ctx.lineTo(x - s, y + 2 + s * 1.4);
        ctx.lineTo(x + s, y + 2 + s * 1.4);
      } else {
        ctx.moveTo(x, y - 2);
        ctx.lineTo(x - s, y - 2 - s * 1.4);
        ctx.lineTo(x + s, y - 2 - s * 1.4);
      }
      ctx.closePath();
      ctx.fill();
      ctx.font = v.font(Math.max(8, s + 2), 700);
      ctx.textAlign = 'center';
      ctx.textBaseline = buy ? 'top' : 'bottom';
      ctx.fillText(buy ? 'B' : 'S', x, buy ? y + 4 + s * 1.4 : y - 4 - s * 1.4);
      ctx.textAlign = 'left';
    }
  }

  /** Writes line geometry into the overlay probe (tests / accessibility); only when it changes. */
  private publish(v: ChartView): void {
    const w = this.w;
    if (!w.probe) return;
    const json = JSON.stringify(
      w.lines.map((l) => ({
        kind: l.kind,
        id: l.id,
        px: l.px,
        y: l.y,
        x: l.lx0 + 20,
        xClose: (l.x0 + l.x1) / 2,
      })),
    );
    const lastY = w.lastY === null ? '' : String(Math.round(w.lastY));
    if (json !== w.probeJson || w.probe.dataset.lastY !== lastY) {
      w.probeJson = json;
      w.probe.dataset.lines = json;
      w.probe.dataset.lastY = lastY;
      w.probe.dataset.plotTop = String(v.plot.y);
      w.probe.dataset.plotBottom = String(v.plot.y + v.plot.h);
      w.probe.textContent = w.lines.map((l) => l.label).join('\n');
    }
  }
}

function hitLine(w: WinState, x: number, y: number): { line: LineGeom; onX: boolean } | null {
  // Topmost (last drawn) first.
  for (let i = w.lines.length - 1; i >= 0; i--) {
    const l = w.lines[i]!;
    if (Math.abs(y - l.y) > 9) continue;
    if (x >= l.x0 && x <= l.x1) return { line: l, onX: true };
  }
  for (let i = w.lines.length - 1; i >= 0; i--) {
    const l = w.lines[i]!;
    const inLabel = x >= l.lx0 && x <= l.lx1 && Math.abs(y - l.y) <= 9;
    if (inLabel || Math.abs(y - l.y) <= HIT) return { line: l, onX: false };
  }
  return null;
}

function handler(w: WinState): PointerHandler {
  const invalidate = () => w.ctx.cores.forEach((c) => c.invalidate());
  return {
    onDown(v, x, y) {
      if (!chartPrefs().enabled || y > v.plot.y + v.plot.h || x > v.plot.x + v.plot.w) return false;
      const hit = hitLine(w, x, y);
      if (!hit) return false;
      if (hit.onX) {
        w.pressX = { kind: hit.line.kind, id: hit.line.id };
        return true;
      }
      if (hit.line.kind === 'position') return false; // the position line is not draggable
      w.drag = { id: hit.line.id, px: hit.line.px, startY: y, moved: false };
      return true;
    },
    onMove(v, x, y, _e, captured) {
      if (captured && w.drag) {
        const px = Math.round(v.pxAt(y));
        if (Math.abs(y - w.drag.startY) > 2) w.drag.moved = true;
        if (w.drag.moved) w.drag.px = px;
        return;
      }
      if (!captured) {
        const hit = chartPrefs().enabled ? hitLine(w, x, y) : null;
        const id = hit?.line.id ?? null;
        if (id !== w.hover) {
          w.hover = id;
          invalidate();
        }
      }
    },
    onUp(_v, x, y) {
      if (w.pressX) {
        const press = w.pressX;
        w.pressX = null;
        const hit = hitLine(w, x, y);
        if (!hit?.onX || hit.line.id !== press.id) return;
        const instId = w.ctx.store.instrument.id;
        if (press.kind === 'position') void closePosition(instId);
        else {
          const o = paper.orders.get(press.id);
          if (o) void cancelOrder(o);
        }
        return;
      }
      const d = w.drag;
      w.drag = null;
      if (!d) return;
      const o = paper.orders.get(d.id);
      if (o && d.moved && d.px !== priceOf(o)) void moveOrder(o, d.px).finally(invalidate);
      invalidate();
    },
    onKey(e) {
      if (e.key === 'Escape' && w.drag) {
        w.drag = null;
        invalidate();
        return true;
      }
      return false;
    },
    cursor(v, x, y) {
      if (w.drag) return 'ns-resize';
      if (!chartPrefs().enabled || y > v.plot.y + v.plot.h) return null;
      const hit = hitLine(w, x, y);
      if (!hit) return null;
      if (hit.onX) return 'pointer';
      return hit.line.kind === 'position' ? null : 'ns-resize';
    },
  };
}

function ensure(ctx: ChartExtensionContext): WinState {
  let w = wins.get(ctx.windowId);
  if (!w) {
    w = {
      ctx,
      lines: [],
      lastY: null,
      drag: null,
      pressX: null,
      hover: null,
      probe: null,
      probeJson: '',
    };
    wins.set(ctx.windowId, w);
  }
  w.ctx = ctx;
  return w;
}

/** Invisible element carrying the drawn lines (data-lines JSON) for tests and screen readers. */
function Probe({ windowId }: { windowId: string; state: ChartWindowState }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const w = wins.get(windowId);
    if (w) {
      w.probe = el;
      w.probeJson = '';
      w.ctx.cores.forEach((c) => c.invalidate());
    }
    const i = setInterval(() => {
      const cur = wins.get(windowId);
      if (cur && cur.probe !== el) {
        cur.probe = el;
        cur.probeJson = '';
      }
    }, 500);
    return () => {
      clearInterval(i);
      const cur = wins.get(windowId);
      if (cur && cur.probe === el) cur.probe = null;
    };
  }, [windowId]);
  return <div ref={ref} className="ctr-probe" data-testid="chart-trading" aria-hidden="true" />;
}

registerChartExtension({
  id: EXT_ID,
  layers: (ctx) => [new TradingLayer(ensure(ctx))],
  attach(ctx) {
    const w = ensure(ctx);
    const h = handler(w);
    // Order lines take precedence over drawings and panning.
    ctx.core.pointerHandlers.unshift(h);
    const redraw = () => ctx.cores.forEach((c) => c.invalidate());
    const un1 = paper.subscribe(redraw);
    const un2 = tradingPrefs.subscribe(redraw);
    return () => {
      const i = ctx.core.pointerHandlers.indexOf(h);
      if (i >= 0) ctx.core.pointerHandlers.splice(i, 1);
      un1();
      un2();
      if (wins.get(ctx.windowId)?.ctx === ctx) wins.delete(ctx.windowId);
    };
  },
  menu(ctx, px): MenuEntry[] {
    const w = wins.get(ctx.windowId);
    const instId = ctx.store.instrument.id;
    const acc = paper.route(activeAccount(), instId);
    const v = ctx.core.view;
    const hit = w && v?.crosshair ? hitLine(w, v.crosshair.x, v.crosshair.y) : null;
    const items: MenuEntry[] = [{ kind: 'separator', id: 'ctr-s' }];
    if (hit && hit.line.kind !== 'position') {
      const o = paper.orders.get(hit.line.id);
      if (o) {
        items.push({
          id: 'ctr-cancel',
          label: `Cancel ${hit.line.label}`,
          onSelect: () => void cancelOrder(o),
        });
        if (px !== null)
          items.push({
            id: 'ctr-move',
            label: `Move order to ${formatPrice(px, ctx.store.instrument)}`,
            onSelect: () => void moveOrder(o, px),
          });
      }
    }
    if (px !== null) {
      const last = ctx.store.lastTrade?.px ?? px;
      const above = px > last;
      const qty = ctx.state().lots || 1;
      items.push({
        kind: 'submenu',
        id: 'ctr-more',
        label: `More orders at ${formatPrice(px, ctx.store.instrument)}`,
        items: [
          {
            id: 'ctr-mit',
            label: above ? 'Sell MIT' : 'Buy MIT',
            onSelect: () =>
              void submitOrder({
                instrumentId: instId,
                side: above ? 'sell' : 'buy',
                type: 'mit',
                stopPx: px,
                qty,
              }),
          },
          {
            id: 'ctr-stl',
            label: above ? 'Buy Stop-Limit' : 'Sell Stop-Limit',
            onSelect: () =>
              void submitOrder({
                instrumentId: instId,
                side: above ? 'buy' : 'sell',
                type: 'stop-limit',
                stopPx: px,
                px: px + (above ? 2 : -2),
                qty,
              }),
          },
        ],
      });
    }
    const pos = paper.position(acc, instId);
    if (pos.qty !== 0)
      items.push(
        { id: 'ctr-close', label: 'Close position', onSelect: () => void closePosition(instId) },
        {
          id: 'ctr-be',
          label: 'Breakeven',
          shortcut: 'H',
          onSelect: () => paper.breakeven(acc, instId),
        },
      );
    if (paper.workingOrders(acc, instId).length)
      items.push({
        id: 'ctr-cancel-all',
        label: 'Cancel all orders',
        onSelect: () => paper.cancelAll(acc, instId),
      });
    const p = tradingPrefs.get().chart;
    items.push({
      id: 'ctr-toggle',
      label: 'Trading on chart',
      checked: p.enabled,
      onSelect: () =>
        tradingPrefs.update((x) => ({ ...x, chart: { ...x.chart, enabled: !x.chart.enabled } })),
    });
    return items;
  },
  Overlay: Probe,
});
