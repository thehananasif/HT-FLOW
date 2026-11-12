import { barsRange, type ChartLayer, type ChartView } from '@htflow/chart-engine';
import type { BarSeries } from '@htflow/market-data';
import { alpha } from '@htflow/ui-kit';
import { withColors, type ChartTypeSettings } from './settings';

/** Point & Figure columns: X boxes (up) and O boxes (down). */
export class PnfLayer implements ChartLayer {
  readonly id = 'pnf';
  constructor(
    private series: () => BarSeries,
    private box: number,
    private get: () => ChartTypeSettings,
  ) {}

  priceRange(i0: number, i1: number) {
    const r = barsRange(this.series().bars, i0, i1);
    return r ? ([r[0] - this.box, r[1] + this.box] as [number, number]) : null;
  }

  draw(v: ChartView): void {
    const s = this.get();
    const p = withColors(v.palette, s.colors);
    const ctx = v.ctx;
    const bars = this.series().bars;
    const B = this.box;
    const cell = Math.max(2, Math.min(v.slotWidth * 0.8, B * v.tickPx * 0.9));
    ctx.lineWidth = Math.max(1, cell / 8);
    for (let i = v.i0; i <= v.i1; i++) {
      const b = bars[i];
      if (!b) continue;
      const x = v.xOf(i);
      const up = (b.dir ?? 0) >= 0;
      const col = up ? p.up : p.down;
      ctx.strokeStyle = col;
      for (let px = b.l; px <= b.h; px += B) {
        const y = v.yOf(px);
        const h = cell / 2;
        if (s.pnf.style === 'boxes') {
          ctx.fillStyle = alpha(col, 0.55);
          ctx.fillRect(x - h, y - h, cell, cell);
        } else if (up) {
          ctx.beginPath();
          ctx.moveTo(x - h, y - h);
          ctx.lineTo(x + h, y + h);
          ctx.moveTo(x + h, y - h);
          ctx.lineTo(x - h, y + h);
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.arc(x, y, h * 0.9, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }
  }
}

/** Kagi lines: thick yang / thin yin segments joined by horizontal shoulders and waists. */
export class KagiLayer implements ChartLayer {
  readonly id = 'kagi';
  constructor(
    private series: () => BarSeries,
    private get: () => ChartTypeSettings,
  ) {}

  priceRange(i0: number, i1: number) {
    return barsRange(this.series().bars, i0, i1);
  }

  draw(v: ChartView): void {
    const s = this.get();
    const p = withColors(v.palette, s.colors);
    const ctx = v.ctx;
    const bars = this.series().bars;
    const width = (th: number | undefined) => (th ? s.kagi.yangWidth : s.kagi.yinWidth);
    const colOf = (th: number | undefined) => (th ? p.up : p.down);
    const seg = (x: number, a: number, b: number, th: number | undefined) => {
      ctx.strokeStyle = colOf(th);
      ctx.lineWidth = width(th);
      ctx.beginPath();
      ctx.moveTo(x, v.yOf(a));
      ctx.lineTo(x, v.yOf(b));
      ctx.stroke();
    };
    for (let i = Math.max(0, v.i0); i <= v.i1 && i < bars.length; i++) {
      const b = bars[i]!;
      const x = v.xOf(i);
      if (i > 0) {
        ctx.strokeStyle = colOf(b.thick0);
        ctx.lineWidth = width(b.thick0);
        ctx.beginPath();
        ctx.moveTo(v.xOf(i - 1), v.yOf(b.o));
        ctx.lineTo(x, v.yOf(b.o));
        ctx.stroke();
      }
      if (b.flip !== undefined && Number.isFinite(b.flip)) {
        seg(x, b.o, b.flip, b.thick0);
        seg(x, b.flip, b.c, b.thick);
      } else seg(x, b.o, b.c, b.thick ?? b.thick0);
    }
  }
}
