/** Per-instrument intraday statistics for watchlist rows (pure, incremental). */
export interface StatsTrade {
  ts: number;
  /** Price in ticks. */
  px: number;
  qty: number;
  side: 'buy' | 'sell' | 'unknown';
}

export const DAY_MS = 86_400_000;

export class RowStats {
  open = Number.NaN;
  last = Number.NaN;
  high = Number.NEGATIVE_INFINITY;
  low = Number.POSITIVE_INFINITY;
  volume = 0;
  buy = 0;
  sell = 0;
  private pv = 0;
  /** Last price (ticks) per time bin, NaN where no trade yet. */
  readonly bins: number[];
  private readonly binMs: number;

  constructor(
    /** Start of the statistics window (epoch ms). */
    readonly from: number,
    span = DAY_MS,
    nBins = 48,
  ) {
    this.binMs = span / nBins;
    this.bins = new Array<number>(nBins).fill(Number.NaN);
  }

  add(trades: readonly StatsTrade[]): void {
    for (const t of trades) {
      if (t.ts < this.from) continue;
      if (Number.isNaN(this.open)) this.open = t.px;
      this.last = t.px;
      if (t.px > this.high) this.high = t.px;
      if (t.px < this.low) this.low = t.px;
      this.volume += t.qty;
      this.pv += t.px * t.qty;
      if (t.side === 'buy') this.buy += t.qty;
      else if (t.side === 'sell') this.sell += t.qty;
      const i = Math.min(this.bins.length - 1, Math.floor((t.ts - this.from) / this.binMs));
      this.bins[i] = t.px;
    }
  }

  get change(): number {
    return this.last - this.open;
  }

  /** Percent change since the window open (NaN without trades). */
  get changePct(): number {
    return this.open ? ((this.last - this.open) / this.open) * 100 : Number.NaN;
  }

  get delta(): number {
    return this.buy - this.sell;
  }

  /** VWAP in ticks. */
  get vwap(): number {
    return this.volume ? this.pv / this.volume : Number.NaN;
  }

  /** Bins up to the last trade, forward-filled (for the sparkline). */
  spark(): number[] {
    let lastIdx = -1;
    for (let i = 0; i < this.bins.length; i++) if (!Number.isNaN(this.bins[i]!)) lastIdx = i;
    const out: number[] = [];
    let prev = Number.NaN;
    for (let i = 0; i <= lastIdx; i++) {
      const v = this.bins[i]!;
      if (!Number.isNaN(v)) prev = v;
      if (!Number.isNaN(prev)) out.push(prev);
    }
    return out;
  }
}

/** Window start for a feed: the last 24 h of what it has loaded (or since its first trade). */
export function statsFrom(firstTs: number | undefined, lastTs: number): number {
  return Math.max(firstTs ?? lastTs, lastTs - DAY_MS);
}

/** Moves item `from` to index `to` (drag-to-reorder). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = list.slice();
  if (from < 0 || from >= out.length) return out;
  const [x] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, x!);
  return out;
}

/** SVG polyline points for a sparkline of `w` × `h`. */
export function sparkPoints(values: readonly number[], w: number, h: number): string {
  if (values.length < 2) return '';
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo || 1;
  return values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - 1 - ((v - lo) / span) * (h - 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

/** Latest funding / open interest of a feed (structural: a MarketStore satisfies it). */
export interface DerivStats {
  funding: { rate: number; nextTs: number } | null;
  openInterest: { oi: number; value: number } | null;
}

/**
 * Text for the "OI / Funding" column: "12.4K · +0.0100%" (open interest · funding rate, 4 dp
 * percent), only the part the feed supplies, "—" when it supplies neither (spot, simulator,
 * venues without a derivatives stream).
 */
export function formatOiFunding(
  s: DerivStats | null | undefined,
  compact: (n: number) => string,
): { text: string; title: string } {
  const parts: string[] = [];
  const titles: string[] = [];
  const oi = s?.openInterest?.oi;
  if (oi !== undefined && Number.isFinite(oi)) {
    parts.push(compact(oi));
    titles.push(`Open interest ${oi.toLocaleString('en-US')}`);
  }
  const fr = s?.funding?.rate;
  if (fr !== undefined && Number.isFinite(fr)) {
    const pct = fr * 100;
    parts.push(`${pct > 0 ? '+' : ''}${pct.toFixed(4)}%`);
    titles.push(`Funding rate ${pct.toFixed(4)}% per interval`);
  }
  if (!parts.length) return { text: '—', title: 'This feed has no open interest / funding data' };
  return { text: parts.join(' · '), title: titles.join(' · ') };
}
