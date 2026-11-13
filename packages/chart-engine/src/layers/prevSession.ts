import {
  buildProfile,
  formatPrice,
  type Bar,
  type BarSeries,
  type VolumeProfile,
} from '@htflow/market-data';
import type { ChartLayer, ChartView } from '../types';
import { rgba, rowTicksFor, sessionStart } from './util';

/**
 * Bar index range [from, to] of the session before the one holding the last bar (sessions start
 * at 00:00 UTC + `offsetMs`), or null when the data holds no complete earlier session.
 */
export function prevSessionRange(
  bars: readonly Bar[],
  offsetMs = 0,
): { from: number; to: number; start: number } | null {
  if (bars.length < 2) return null;
  const ss = (t: number) => sessionStart(t - offsetMs) + offsetMs;
  const cur = ss(bars[bars.length - 1]!.t);
  let to = bars.length - 1;
  while (to >= 0 && ss(bars[to]!.t) === cur) to--;
  if (to < 0) return null;
  const prev = ss(bars[to]!.t);
  let from = to;
  while (from > 0 && ss(bars[from - 1]!.t) === prev) from--;
  return { from, to, start: prev };
}

/**
 * Previous-session volume profile (P31) drawn against the left edge of the price pane: POC row
 * highlighted, value area tinted, a label with the POC price.
 */
export class PrevSessionProfileLayer implements ChartLayer {
  readonly id = 'prev-session-profile';
  visible = true;
  /** Share of the plot width the longest row may take. */
  widthPct = 0.16;
  valueAreaPct = 0.7;
  offsetMs = 0;
  private cache: { key: string; prof: VolumeProfile } | null = null;
  /** Last drawn profile (tests / accessibility). */
  last: { poc: number; vah: number; val: number; start: number } | null = null;

  constructor(private series: () => BarSeries) {}

  profile(): { prof: VolumeProfile; start: number } | null {
    const bars = this.series().bars;
    const r = prevSessionRange(bars, this.offsetMs);
    if (!r) return null;
    const key = `${r.start}|${r.from}|${r.to}|${bars[r.from]!.t}|${this.valueAreaPct}`;
    if (this.cache?.key !== key)
      this.cache = { key, prof: buildProfile(bars, r.from, r.to, this.valueAreaPct) };
    return { prof: this.cache.prof, start: r.start };
  }

  draw(v: ChartView): void {
    this.last = null;
    if (!this.visible) return;
    const res = this.profile();
    if (!res || res.prof.maxVol <= 0 || Number.isNaN(res.prof.poc)) return;
    const { prof, start } = res;
    this.last = { poc: prof.poc, vah: prof.vah, val: prof.val, start };
    const { ctx, palette: p } = v;
    const rt = rowTicksFor(v.tickPx, 2);
    const rows = new Map<number, number>();
    let max = 0;
    for (const [px, l] of prof.levels) {
      const k = Math.floor(px / rt) * rt;
      const nv = (rows.get(k) ?? 0) + l.vol;
      rows.set(k, nv);
      if (nv > max) max = nv;
    }
    const maxW = v.plot.w * this.widthPct;
    const x0 = v.plot.x;
    const h = Math.max(1, rt * v.tickPx - (rt * v.tickPx > 3 ? 1 : 0));
    const pocRow = Math.floor(prof.poc / rt) * rt;
    ctx.save();
    ctx.beginPath();
    ctx.rect(v.plot.x, 0, v.plot.w, v.plot.h);
    ctx.clip();
    for (const [k, vol] of rows) {
      const y = v.yOf(k + rt - 0.5);
      if (y > v.plot.h || y + h < 0) continue;
      const inVa = k >= prof.val - rt + 1 && k <= prof.vah;
      ctx.fillStyle =
        k === pocRow ? rgba(p.textSoft, 0.8) : rgba(p.clusterStrong, inVa ? 0.55 : 0.25);
      ctx.fillRect(x0, y, Math.max(1, (vol / max) * maxW), h);
    }
    // Value-area edges and the POC label.
    ctx.strokeStyle = rgba(p.textTertiary, 0.8);
    ctx.setLineDash([3, 3]);
    for (const px of [prof.vah, prof.val]) {
      const y = Math.round(v.yOf(px)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 + maxW, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    const yPoc = v.yOf(prof.poc);
    ctx.font = v.font(10, 600);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = p.textSecondary;
    ctx.fillText(`Prev session POC ${formatPrice(prof.poc, v.instrument)}`, x0 + 4, yPoc - 3);
    ctx.textBaseline = 'alphabetic';
    ctx.restore();
  }
}
