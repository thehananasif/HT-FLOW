import type { ChartLayer, ChartView, SlotSource } from '@htflow/chart-engine';
import { formatCompact } from '@htflow/market-data';
import { alpha } from '@htflow/ui-kit';
import type { CotRow } from '../../state/cot';
import type { CotData } from './cotModel';
import { withColors, type ChartTypeSettings } from './settings';

const weekT = (r: CotRow) => Date.parse(r.date + 'T00:00:00Z');

export function cotSource(data: () => CotData): SlotSource {
  return { count: () => data().rows.length, timeAt: (i) => weekT(data().rows[i]!) || 0 };
}

const sgn = (n: number) => (n > 0 ? '+' : '') + formatCompact(n);

/**
 * Main plot: a positioning table of the newest visible week (long / short / net / change / share
 * of open interest per trader category). CFTC publishes no prices, so there is no price line. A
 * "SAMPLE DATA" watermark is drawn whenever the rows are the bundled offline sample.
 */
export class CotTableLayer implements ChartLayer {
  readonly id = 'cot-table';
  constructor(
    private data: () => CotData,
    private get: () => ChartTypeSettings,
  ) {}

  priceRange(): [number, number] | null {
    return [0, 1];
  }

  draw(v: ChartView): void {
    const p = withColors(v.palette, this.get().colors);
    const ctx = v.ctx;
    const d = this.data();
    const cx = v.plot.x + v.plot.w / 2;
    if (d.sample) {
      ctx.font = v.font(40, 700);
      ctx.textAlign = 'center';
      ctx.fillStyle = alpha(p.warning, 0.12);
      ctx.fillText('SAMPLE DATA', cx, v.plot.h / 2);
    }
    if (!d.rows.length) {
      ctx.font = v.font(13);
      ctx.textAlign = 'center';
      ctx.fillStyle = d.status === 'error' || d.status === 'empty' ? p.warning : p.textSecondary;
      ctx.fillText(d.message, cx, v.plot.h / 2 + (d.sample ? 0 : -6));
      return;
    }
    const row = d.rows[Math.min(d.rows.length - 1, Math.max(0, Math.floor(v.i1)))]!;
    ctx.font = v.font(12, 600);
    ctx.textAlign = 'left';
    ctx.fillStyle = p.textPrimary;
    const x0 = v.plot.x + 12;
    let y = v.plot.y + 22;
    const lh = 18;
    ctx.fillText(`Week of ${row.date} · open interest ${formatCompact(row.openInterest)}`, x0, y);
    y += lh + 4;
    const cols = [0, 150, 230, 310, 400, 490];
    ctx.font = v.font(11, 600);
    ctx.fillStyle = p.textSecondary;
    ['Category', 'Long', 'Short', 'Net', 'Δ net', '% OI net'].forEach((h, i) =>
      ctx.fillText(h, x0 + cols[i]!, y),
    );
    ctx.font = v.font(11);
    for (const g of row.groups) {
      y += lh;
      ctx.fillStyle = p.textPrimary;
      ctx.fillText(g.label, x0 + cols[0]!, y);
      ctx.fillText(formatCompact(g.long), x0 + cols[1]!, y);
      ctx.fillText(formatCompact(g.short), x0 + cols[2]!, y);
      ctx.fillStyle = g.net >= 0 ? p.up : p.down;
      ctx.fillText(sgn(g.net), x0 + cols[3]!, y);
      ctx.fillStyle = g.netChange >= 0 ? p.up : p.down;
      ctx.fillText(sgn(g.netChange), x0 + cols[4]!, y);
      ctx.fillStyle = p.textSecondary;
      ctx.fillText(
        row.openInterest ? `${((g.net / row.openInterest) * 100).toFixed(1)}%` : '–',
        x0 + cols[5]!,
        y,
      );
    }
  }
}

/** Pane slot: net positions of the i-th trader category (or open interest when `slot` is -1). */
export class CotPaneLayer implements ChartLayer {
  readonly id: string;
  height = 84;
  constructor(
    private slot: number,
    private data: () => CotData,
    private get: () => ChartTypeSettings,
  ) {
    this.id = slot < 0 ? 'cot-oi' : `cot-g${slot}`;
  }

  private group() {
    const d = this.data();
    return d.rows[d.rows.length - 1]?.groups[this.slot];
  }

  private on(): boolean {
    if (!this.data().rows.length) return false;
    if (this.slot < 0) return this.get().cot.openInterest;
    const g = this.group();
    return !!g && !this.get().cot.hidden.includes(g.key);
  }

  private val(r: CotRow): number {
    return this.slot < 0 ? r.openInterest : (r.groups[this.slot]?.net ?? 0);
  }

  bottomHeight(): number {
    return this.on() ? this.height : 0;
  }

  draw(v: ChartView): void {
    if (!this.on()) return;
    const p = withColors(v.palette, this.get().colors);
    const r = v.bottom;
    const ctx = v.ctx;
    const w = this.data().rows;
    ctx.fillStyle = p.chartBg;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = p.divider;
    ctx.beginPath();
    ctx.moveTo(r.x, r.y + 0.5);
    ctx.lineTo(r.x + r.w, r.y + 0.5);
    ctx.stroke();
    let lo = 0;
    let hi = 0;
    const i0 = Math.max(0, v.i0);
    for (let i = i0; i <= v.i1 && i < w.length; i++) {
      const x = this.val(w[i]!);
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
    if (hi === lo) hi = lo + 1;
    const y = (x: number) => r.y + 14 + (1 - (x - lo) / (hi - lo)) * (r.h - 20);
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    if (this.slot < 0) {
      ctx.strokeStyle = p.info;
      ctx.beginPath();
      for (let i = i0; i <= v.i1 && i < w.length; i++) {
        const yy = y(this.val(w[i]!));
        if (i === i0) ctx.moveTo(v.xOf(i), yy);
        else ctx.lineTo(v.xOf(i), yy);
      }
      ctx.stroke();
    } else {
      const bw = Math.max(1, v.slotWidth * 0.7);
      const y0 = y(0);
      for (let i = i0; i <= v.i1 && i < w.length; i++) {
        const val = this.val(w[i]!);
        ctx.fillStyle = val >= 0 ? p.up : p.down;
        const yy = y(val);
        ctx.fillRect(v.xOf(i) - bw / 2, Math.min(yy, y0), bw, Math.max(1, Math.abs(y0 - yy)));
      }
    }
    ctx.restore();
    const last = w[Math.min(v.i1, w.length - 1)];
    const label = this.slot < 0 ? 'Open interest' : `${this.group()?.label ?? ''} net`;
    ctx.font = v.font(10);
    ctx.textAlign = 'left';
    ctx.fillStyle = p.textSecondary;
    ctx.fillText(
      `${label} ${last ? formatCompact(this.val(last)) : ''}${this.data().sample ? ' · sample' : ''}`,
      r.x + 6,
      r.y + 8,
    );
  }
}
