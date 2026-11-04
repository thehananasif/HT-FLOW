import { formatCompact, formatPrice, type Instrument, type OrderBook } from '@htflow/market-data';
import type { Order, Position } from '@htflow/trading';
import type { DomModel } from './model';

export type DomColumnId =
  'orders' | 'today' | 'price' | 'bidChg' | 'bid' | 'sells' | 'buys' | 'ask' | 'askChg';

export interface DomColumn {
  id: DomColumnId;
  label: string;
  /** Relative width weight. */
  weight: number;
  visible: boolean;
}

export const DEFAULT_COLUMNS: DomColumn[] = [
  { id: 'orders', label: 'Orders / PnL', weight: 1.1, visible: true },
  { id: 'today', label: 'Today', weight: 1.3, visible: true },
  { id: 'price', label: 'Price', weight: 1.4, visible: true },
  { id: 'bidChg', label: 'Chg.', weight: 0.8, visible: true },
  { id: 'bid', label: 'Bid', weight: 2, visible: true },
  { id: 'sells', label: 'Sells', weight: 1, visible: true },
  { id: 'buys', label: 'Buys', weight: 1, visible: true },
  { id: 'ask', label: 'Ask', weight: 2, visible: true },
  { id: 'askChg', label: 'Chg.', weight: 0.8, visible: true },
];

export interface DomPalette {
  bg: string;
  surface1: string;
  surface2: string;
  surface3: string;
  divider: string;
  border: string;
  textPrimary: string;
  textSecondary: string;
  textSoft: string;
  up: string;
  down: string;
  info: string;
  volume: string;
  warning: string;
}

export interface DomFrame {
  book: OrderBook;
  model: DomModel;
  instrument: Instrument;
  lastPx: number;
  orders: Order[];
  position: Position | null;
  pnlPerTick: number;
}

export interface DomHit {
  column: DomColumnId;
  px: number;
}

function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1, 7), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/**
 * Canvas DOM ladder (board 24). Rows are price ticks around a centre price; the centre follows
 * the market when price leaves the middle band (auto-centre), or stays put while the user scrolls.
 */
export class DomLadder {
  rowHeight = 22;
  headerHeight = 24;
  columns: DomColumn[] = DEFAULT_COLUMNS.map((c) => ({ ...c }));
  centerPx = Number.NaN;
  autoCenter = true;
  /** Ticks per row (price grouping 1, 2, 5, 10). */
  grouping = 1;
  bigSize = Infinity;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private colX: { id: DomColumnId; x: number; w: number }[] = [];

  constructor(
    readonly canvas: HTMLCanvasElement,
    public palette: DomPalette,
    private font = '"Geist", "Segoe UI", sans-serif',
  ) {}

  resize(w: number, h: number): void {
    this.dpr = window.devicePixelRatio || 1;
    this.width = w;
    this.height = h;
    this.canvas.width = Math.floor(w * this.dpr);
    this.canvas.height = Math.floor(h * this.dpr);
    this.layoutColumns();
  }

  private layoutColumns(): void {
    const vis = this.columns.filter((c) => c.visible);
    const total = vis.reduce((a, c) => a + c.weight, 0);
    let x = 0;
    this.colX = vis.map((c) => {
      const w = Math.floor((c.weight / total) * this.width);
      const r = { id: c.id, x, w };
      x += w;
      return r;
    });
  }

  get rows(): number {
    return Math.max(1, Math.floor((this.height - this.headerHeight) / this.rowHeight));
  }

  scroll(rows: number): void {
    this.autoCenter = false;
    this.centerPx += rows * this.grouping;
  }

  recenter(): void {
    this.autoCenter = true;
    this.centerPx = Number.NaN;
  }

  pxAtRow(r: number): number {
    const half = Math.floor(this.rows / 2);
    return this.centerPx + (half - r) * this.grouping;
  }

  hitTest(x: number, y: number): DomHit | null {
    if (y < this.headerHeight) return null;
    const r = Math.floor((y - this.headerHeight) / this.rowHeight);
    const col = this.colX.find((c) => x >= c.x && x < c.x + c.w);
    if (!col) return null;
    return { column: col.id, px: this.pxAtRow(r) };
  }

  draw(f: DomFrame): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx || this.width < 10) return;
    const p = this.palette;
    const { book, model } = f;
    const g = this.grouping;
    const ref = !Number.isNaN(f.lastPx) ? f.lastPx : book.mid;
    if (Number.isNaN(this.centerPx) && !Number.isNaN(ref)) this.centerPx = Math.round(ref / g) * g;
    if (this.autoCenter && !Number.isNaN(ref)) {
      const band = Math.max(2, Math.floor(this.rows * 0.3)) * g;
      if (Math.abs(ref - this.centerPx) > band) this.centerPx = Math.round(ref / g) * g;
    }
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = p.bg;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.textBaseline = 'middle';
    // Header.
    ctx.font = `400 11px ${this.font}`;
    ctx.fillStyle = p.textSecondary;
    ctx.textAlign = 'center';
    for (const c of this.colX) {
      const def = this.columns.find((d) => d.id === c.id)!;
      ctx.fillText(def.label, c.x + c.w / 2, this.headerHeight / 2);
    }
    ctx.fillStyle = p.divider;
    ctx.fillRect(0, this.headerHeight - 1, this.width, 1);
    if (Number.isNaN(this.centerPx)) return;

    const rows = this.rows;
    const sizeAt = (m: Map<number, number>, px: number) => {
      if (g === 1) return m.get(px) ?? 0;
      let s = 0;
      for (let k = 0; k < g; k++) s += m.get(px + k) ?? 0;
      return s;
    };
    let maxBook = 0;
    let maxToday = 0;
    let maxRecent = 0;
    for (let r = 0; r < rows; r++) {
      const px = this.pxAtRow(r);
      maxBook = Math.max(maxBook, sizeAt(book.bids, px), sizeAt(book.asks, px));
      maxToday = Math.max(maxToday, sizeAt(model.session, px));
      maxRecent = Math.max(maxRecent, sizeAt(model.recentBuys, px), sizeAt(model.recentSells, px));
    }
    const ordersAt = new Map<number, Order[]>();
    for (const o of f.orders) {
      const opx = o.type === 'stop' ? o.stopPx! : o.px!;
      const k = Math.floor(opx / g) * g;
      const arr = ordersAt.get(k) ?? [];
      arr.push(o);
      ordersAt.set(k, arr);
    }
    const col = (id: DomColumnId) => this.colX.find((c) => c.id === id);
    const bestBid = book.bestBid;
    const bestAsk = book.bestAsk;

    for (let r = 0; r < rows; r++) {
      const px = this.pxAtRow(r);
      const y = this.headerHeight + r * this.rowHeight;
      const h = this.rowHeight - 1;
      const bid = sizeAt(book.bids, px);
      const ask = sizeAt(book.asks, px);
      const isAskSide = px >= bestAsk;
      const isBidSide = px <= bestBid;
      for (const c of this.colX) {
        const cx = c.x;
        const cw = c.w - 1;
        switch (c.id) {
          case 'orders': {
            const os = ordersAt.get(Math.floor(px / g) * g);
            ctx.fillStyle = p.bg;
            ctx.fillRect(cx, y, cw, h);
            if (os?.length) {
              const q = os.reduce((a, o) => a + (o.qty - o.filled), 0);
              const buy = os[0]!.side === 'buy';
              ctx.fillStyle = p.info;
              ctx.fillRect(cx + cw - 6, y + 2, 4, h - 4);
              ctx.fillStyle = buy ? p.up : p.down;
              ctx.font = `600 12px ${this.font}`;
              ctx.textAlign = 'right';
              ctx.fillText(
                `${os[0]!.type === 'stop' ? 'S' : 'L'} ${formatCompact(q)}`,
                cx + cw - 10,
                y + h / 2,
              );
            } else if (
              f.position &&
              f.position.qty !== 0 &&
              Math.abs(px - f.position.avgPx) < g / 2 + 0.5
            ) {
              ctx.fillStyle = p.warning;
              ctx.font = `600 11px ${this.font}`;
              ctx.textAlign = 'right';
              ctx.fillText(
                `AVG ${f.position.qty > 0 ? '+' : ''}${f.position.qty}`,
                cx + cw - 6,
                y + h / 2,
              );
            }
            break;
          }
          case 'today': {
            ctx.fillStyle = p.bg;
            ctx.fillRect(cx, y, cw, h);
            const v = sizeAt(model.session, px);
            if (v > 0 && maxToday > 0) {
              ctx.fillStyle = rgba(p.volume, 0.9);
              ctx.fillRect(cx + 2, y + 2, Math.max(1, (v / maxToday) * (cw - 4)), h - 4);
            }
            break;
          }
          case 'price': {
            const isLast = Math.floor(f.lastPx / g) * g === px;
            ctx.fillStyle = isLast ? p.surface3 : p.surface1;
            ctx.fillRect(cx, y, cw, h);
            ctx.fillStyle = p.textPrimary;
            ctx.font = `${isLast ? 700 : 600} 12px ${this.font}`;
            ctx.textAlign = 'center';
            ctx.fillText(formatPrice(px, f.instrument), cx + cw / 2, y + h / 2);
            break;
          }
          case 'bid':
          case 'ask': {
            const isBid = c.id === 'bid';
            const size = isBid ? bid : ask;
            const tint = isBid ? p.up : p.down;
            ctx.fillStyle = rgba(tint, (isBid ? isBidSide : isAskSide) ? 0.08 : 0.04);
            ctx.fillRect(cx, y, cw, h);
            if (size > 0) {
              const w = Math.max(2, (size / maxBook) * cw);
              ctx.fillStyle = size >= this.bigSize ? tint : rgba(tint, 0.75);
              if (isBid) ctx.fillRect(cx + cw - w, y + 1, w, h - 2);
              else ctx.fillRect(cx, y + 1, w, h - 2);
              ctx.fillStyle = p.textPrimary;
              ctx.font = `${size >= this.bigSize ? 700 : 500} 12px ${this.font}`;
              ctx.textAlign = isBid ? 'right' : 'left';
              ctx.fillText(formatCompact(size), isBid ? cx + cw - 5 : cx + 5, y + h / 2);
            }
            break;
          }
          case 'sells':
          case 'buys': {
            const m = c.id === 'sells' ? model.recentSells : model.recentBuys;
            const v = sizeAt(m, px);
            ctx.fillStyle = p.bg;
            ctx.fillRect(cx, y, cw, h);
            if (v > 0) {
              const k = maxRecent > 0 ? v / maxRecent : 0;
              ctx.fillStyle = rgba(c.id === 'sells' ? p.down : p.up, 0.25 + k * 0.5);
              ctx.fillRect(cx, y, cw, h);
              ctx.fillStyle = p.textPrimary;
              ctx.font = `${k > 0.6 ? 700 : 400} 12px ${this.font}`;
              ctx.textAlign = 'center';
              ctx.fillText(formatCompact(v), cx + cw / 2, y + h / 2);
            }
            break;
          }
          case 'bidChg':
          case 'askChg': {
            const ch = c.id === 'bidChg' ? model.bidChange(px, book) : model.askChange(px, book);
            ctx.fillStyle = c.id === 'bidChg' ? rgba(p.up, 0.04) : rgba(p.down, 0.05);
            ctx.fillRect(cx, y, cw, h);
            if (Math.abs(ch) > 1e-9) {
              ctx.fillStyle = ch > 0 ? p.textSoft : p.textSecondary;
              ctx.font = `400 11px ${this.font}`;
              ctx.textAlign = 'center';
              ctx.fillText(formatCompact(Math.round(ch * 1000) / 1000), cx + cw / 2, y + h / 2);
            }
            break;
          }
        }
      }
      // White line between best ask and best bid (spread marker).
      if (px === Math.floor(bestBid / g) * g) {
        ctx.fillStyle = p.textPrimary;
        ctx.fillRect(0, y - 1, this.width, 2);
      }
    }
    void col;
    if (f.position && f.position.qty !== 0 && !Number.isNaN(f.lastPx)) {
      const pnl = (f.lastPx - f.position.avgPx) * f.pnlPerTick * f.position.qty;
      const c = this.colX.find((x) => x.id === 'orders');
      if (c) {
        ctx.fillStyle = pnl >= 0 ? p.up : p.down;
        ctx.font = `600 11px ${this.font}`;
        ctx.textAlign = 'left';
        ctx.fillText(`${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`, c.x + 4, this.headerHeight / 2);
      }
    }
  }
}
