import type { ChartLayer, ChartView, SlotSource } from '@htflow/chart-engine';
import { formatCompact } from '@htflow/market-data';
import { alpha } from '@htflow/ui-kit';
import { COT_SAMPLE, type CotRow } from './cotSample';
import { withColors, type ChartTypeSettings } from './settings';

export interface CotWeek {
  t: number;
  /** Price in ticks (sample relative price × anchor). */
  px: number;
  commercials: number;
  nonCommercials: number;
  nonReportable: number;
  openInterest: number;
}

/** Weekly rows of the bundled sample, priced around `anchorPx` (ticks). */
export function cotWeeks(anchorPx: number, rows: readonly CotRow[] = COT_SAMPLE): CotWeek[] {
  const lastRel = rows[rows.length - 1]?.[1] ?? 1;
  return rows.map((r) => ({
    t: Date.parse(r[0] + 'T00:00:00Z'),
    px: Math.round((anchorPx * r[1]) / lastRel),
    commercials: r[2] - r[3],
    nonCommercials: r[4] - r[5],
    nonReportable: r[6] - r[7],
    openInterest: r[8],
  }));
}

export function cotSource(weeks: () => CotWeek[]): SlotSource {
  return { count: () => weeks().length, timeAt: (i) => weeks()[i]?.t ?? 0 };
}

/** Weekly price line with a "Sample data" watermark (no COT feed exists yet). */
export class CotPriceLayer implements ChartLayer {
  readonly id = 'cot-price';
  constructor(
    private weeks: () => CotWeek[],
    private get: () => ChartTypeSettings,
  ) {}

  priceRange(i0: number, i1: number): [number, number] | null {
    const w = this.weeks();
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = Math.max(0, i0); i <= i1 && i < w.length; i++) {
      lo = Math.min(lo, w[i]!.px);
      hi = Math.max(hi, w[i]!.px);
    }
    return Number.isFinite(lo) ? [lo, hi] : null;
  }

  draw(v: ChartView): void {
    const p = withColors(v.palette, this.get().colors);
    const ctx = v.ctx;
    const w = this.weeks();
    ctx.font = v.font(40, 700);
    ctx.textAlign = 'center';
    ctx.fillStyle = alpha(p.textPrimary, 0.06);
    ctx.fillText('SAMPLE DATA', v.plot.x + v.plot.w / 2, v.plot.h / 2);
    ctx.strokeStyle = p.textPrimary;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = Math.max(0, v.i0); i <= v.i1 && i < w.length; i++) {
      const x = v.xOf(i);
      const y = v.yOf(w[i]!.px);
      if (i === Math.max(0, v.i0)) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

type Key = 'commercials' | 'nonCommercials' | 'nonReportable' | 'openInterest';
const LABEL: Record<Key, string> = {
  commercials: 'Commercials net',
  nonCommercials: 'Non-commercials net',
  nonReportable: 'Non-reportable net',
  openInterest: 'Open interest',
};

/** One weekly COT sub-pane (histogram of net positions, or OI line). */
export class CotPaneLayer implements ChartLayer {
  readonly id: string;
  height = 84;
  constructor(
    private key: Key,
    private weeks: () => CotWeek[],
    private get: () => ChartTypeSettings,
  ) {
    this.id = `cot-${key}`;
  }

  private on(): boolean {
    return this.get().cot[this.key];
  }

  bottomHeight(): number {
    return this.on() ? this.height : 0;
  }

  draw(v: ChartView): void {
    if (!this.on()) return;
    const p = withColors(v.palette, this.get().colors);
    const r = v.bottom;
    const ctx = v.ctx;
    const w = this.weeks();
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
      lo = Math.min(lo, w[i]![this.key]);
      hi = Math.max(hi, w[i]![this.key]);
    }
    if (hi === lo) hi = lo + 1;
    const y = (x: number) => r.y + 14 + (1 - (x - lo) / (hi - lo)) * (r.h - 20);
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    if (this.key === 'openInterest') {
      ctx.strokeStyle = p.info;
      ctx.beginPath();
      for (let i = i0; i <= v.i1 && i < w.length; i++) {
        if (i === i0) ctx.moveTo(v.xOf(i), y(w[i]!.openInterest));
        else ctx.lineTo(v.xOf(i), y(w[i]!.openInterest));
      }
      ctx.stroke();
    } else {
      const bw = Math.max(1, v.slotWidth * 0.7);
      const y0 = y(0);
      for (let i = i0; i <= v.i1 && i < w.length; i++) {
        const val = w[i]![this.key];
        ctx.fillStyle = val >= 0 ? p.up : p.down;
        const yy = y(val);
        ctx.fillRect(v.xOf(i) - bw / 2, Math.min(yy, y0), bw, Math.max(1, Math.abs(y0 - yy)));
      }
    }
    ctx.restore();
    const last = w[Math.min(v.i1, w.length - 1)];
    ctx.font = v.font(10);
    ctx.textAlign = 'left';
    ctx.fillStyle = p.textSecondary;
    ctx.fillText(
      `${LABEL[this.key]} ${last ? formatCompact(last[this.key]) : ''} · sample`,
      r.x + 6,
      r.y + 8,
    );
  }
}
