import type { ChartLayer, ChartView, SlotSource } from '@htflow/chart-engine';
import {
  buildTpo,
  formatPrice,
  type BarSeries,
  type SessionRules,
  type TpoProfile,
} from '@htflow/market-data';
import { alpha } from '@htflow/ui-kit';
import { withColors, type ChartTypeSettings } from './settings';

const DAY = 86_400_000;
const H = 3_600_000;

/** Profile key for a TPO period start (split / merge profiles). */
export function tpoProfileKey(
  split: ChartTypeSettings['tpo']['split'],
  rules: SessionRules | null,
): (t: number) => number {
  switch (split) {
    case '1h':
      return (t) => Math.floor(t / H) * H;
    case '4h':
      return (t) => Math.floor(t / (4 * H)) * (4 * H);
    case 'week':
      // weeks start Monday 00:00 UTC
      return (t) => Math.floor((t - 4 * DAY) / (7 * DAY)) * 7 * DAY + 4 * DAY;
    case 'session':
      return rules ? (t) => rules.sessionStart(t) : (t) => Math.floor(t / DAY) * DAY;
    default:
      return (t) => Math.floor(t / DAY) * DAY;
  }
}

/**
 * Caches TPO profiles for a period series and the current settings; one slot per profile.
 */
export class TpoModel {
  private key = '';
  private profiles: TpoProfile[] = [];
  constructor(
    private series: () => BarSeries,
    private get: () => ChartTypeSettings,
    private rowTicks: () => number,
  ) {}

  list(): TpoProfile[] {
    const s = this.series();
    const st = this.get().tpo;
    const rt = st.rowTicks > 0 ? st.rowTicks : this.rowTicks();
    const key = `${s.version}|${s.bars.length}|${rt}|${st.split}|${st.valueAreaPct}|${st.ibPeriods}`;
    if (key !== this.key) {
      this.key = key;
      this.profiles = buildTpo(s.bars, {
        rowTicks: rt,
        valueAreaPct: st.valueAreaPct / 100,
        ibPeriods: st.ibPeriods,
        profileKey: tpoProfileKey(st.split, s.rules),
      });
    }
    return this.profiles;
  }

  source(): SlotSource {
    return { count: () => this.list().length, timeAt: (i) => this.list()[i]?.start ?? 0 };
  }
}

/** TPO Chart (P33 #6): letters per period, POC, value area, initial balance, single prints. */
export class TpoLayer implements ChartLayer {
  readonly id = 'tpo';
  constructor(
    private model: TpoModel,
    private get: () => ChartTypeSettings,
  ) {}

  priceRange(i0: number, i1: number): [number, number] | null {
    const ps = this.model.list();
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = Math.max(0, i0); i <= i1 && i < ps.length; i++) {
      const p = ps[i]!;
      lo = Math.min(lo, p.lo * p.rowTicks);
      hi = Math.max(hi, (p.hi + 1) * p.rowTicks);
    }
    return Number.isFinite(lo) ? [lo, hi] : null;
  }

  draw(v: ChartView): void {
    const s = this.get();
    const st = s.tpo;
    const p = withColors(v.palette, s.colors);
    const ctx = v.ctx;
    const ps = this.model.list();
    ctx.save();
    ctx.beginPath();
    ctx.rect(v.plot.x, v.plot.y, v.plot.w, v.plot.h);
    ctx.clip();
    for (let i = v.i0; i <= v.i1 && i < ps.length; i++) {
      const pr = ps[i]!;
      const rt = pr.rowTicks;
      const rowH = rt * v.tickPx;
      const left = v.xOf(i) - v.slotWidth / 2 + 14;
      const avail = v.slotWidth - 24;
      const maxN = Math.max(1, pr.maxCount);
      const cw = Math.max(1, Math.min(10, avail / maxN));
      const letters = st.display === 'letters' && cw >= 6 && rowH >= 8;
      const fs = Math.max(7, Math.min(11, Math.floor(Math.min(rowH, cw * 1.6))));
      ctx.font = v.font(fs, 500, true);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const yRow = (r: number) => v.yOf((r + 1) * rt - 0.5);
      // value area band
      if (st.showValueArea && Number.isFinite(pr.vah)) {
        ctx.fillStyle = alpha(p.textPrimary, 0.06);
        const y0 = yRow(pr.vah);
        ctx.fillRect(left - 2, y0, avail + 4, yRow(pr.val - 1) - y0);
      }
      for (const [r, list] of pr.rows) {
        const y = yRow(r);
        const inVa = r >= pr.val && r <= pr.vah;
        const single = st.showSingles && list.length === 1 && pr.periods.length > 1;
        if (st.showPoc && r === pr.poc) {
          ctx.fillStyle = alpha(p.warning, 0.28);
          ctx.fillRect(left - 2, y, list.length * cw + 4, Math.max(1, rowH));
        }
        if (single) {
          ctx.fillStyle = alpha(p.special, 0.3);
          ctx.fillRect(left - 2, y, cw + 4, Math.max(1, rowH));
        }
        for (let k = 0; k < list.length; k++) {
          const per = pr.periods[list[k]!]!;
          const x = left + k * cw;
          const col = inVa && st.showValueArea ? p.textPrimary : p.textTertiary;
          if (letters) {
            ctx.fillStyle = per.idx < st.ibPeriods && st.showIb ? p.info : col;
            ctx.fillText(per.letter, x + cw / 2, y + rowH / 2);
          } else {
            ctx.fillStyle = alpha(per.idx < st.ibPeriods && st.showIb ? p.info : col, 0.7);
            ctx.fillRect(x, y + 0.5, Math.max(1, cw - 1), Math.max(1, rowH - 1));
          }
        }
      }
      // initial balance bar
      if (st.showIb && Number.isFinite(pr.ibLo)) {
        ctx.fillStyle = p.info;
        const y0 = yRow(pr.ibHi);
        ctx.fillRect(left - 9, y0, 3, yRow(pr.ibLo - 1) - y0);
      }
      // open / close markers
      ctx.fillStyle = p.textSecondary;
      ctx.fillRect(left - 13, yRow(pr.open) + rowH / 2 - 1, 4, 2);
      ctx.fillStyle = p.textPrimary;
      ctx.fillRect(left - 13, yRow(pr.close) + rowH / 2 - 1, 4, 2);
      // profile separator + header
      const sx = v.xOf(i) - v.slotWidth / 2;
      ctx.strokeStyle = p.divider;
      ctx.beginPath();
      ctx.moveTo(Math.round(sx) + 0.5, 0);
      ctx.lineTo(Math.round(sx) + 0.5, v.plot.h);
      ctx.stroke();
      ctx.textAlign = 'left';
      ctx.font = v.font(10);
      ctx.fillStyle = p.textTertiary;
      const d = new Date(pr.start);
      const label = `${d.toISOString().slice(5, 16).replace('T', ' ')} · POC ${formatPrice(pr.poc * rt, v.instrument)} · VA ${formatPrice(pr.val * rt, v.instrument)}–${formatPrice((pr.vah + 1) * rt, v.instrument)}`;
      ctx.fillText(label, sx + 6, v.plot.h - 10);
    }
    ctx.restore();
  }
}
