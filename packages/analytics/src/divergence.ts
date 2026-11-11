/** Time bar with price OHLC and the cumulative delta (CVD) path inside the bar. */
export interface CvdBar {
  /** Bar open time (aligned to the timeframe), epoch ms. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  cvdHigh: number;
  cvdLow: number;
  cvdClose: number;
  vol: number;
}

/** Builds closed time bars carrying CVD extremes. Only closed bars are evaluated for signals. */
export class CvdBarSeries {
  readonly bars: CvdBar[] = [];
  cur: CvdBar | null = null;

  constructor(
    readonly tfMs: number,
    readonly maxBars = 300,
  ) {}

  /** Adds a trade with the CVD after it. Returns the bar that closed because of it, if any. */
  add(ts: number, px: number, qty: number, cvdAfter: number): CvdBar | null {
    const t = Math.floor(ts / this.tfMs) * this.tfMs;
    let closed: CvdBar | null = null;
    if (this.cur && t > this.cur.t) closed = this.close();
    if (!this.cur) {
      this.cur = {
        t,
        o: px,
        h: px,
        l: px,
        c: px,
        cvdHigh: cvdAfter,
        cvdLow: cvdAfter,
        cvdClose: cvdAfter,
        vol: qty,
      };
      return closed;
    }
    const b = this.cur;
    if (px > b.h) b.h = px;
    if (px < b.l) b.l = px;
    b.c = px;
    if (cvdAfter > b.cvdHigh) b.cvdHigh = cvdAfter;
    if (cvdAfter < b.cvdLow) b.cvdLow = cvdAfter;
    b.cvdClose = cvdAfter;
    b.vol += qty;
    return closed;
  }

  /** Closes the forming bar once its period has ended (quiet markets). */
  closeUntil(now: number): CvdBar | null {
    if (this.cur && now >= this.cur.t + this.tfMs) return this.close();
    return null;
  }

  private close(): CvdBar {
    const b = this.cur!;
    this.bars.push(b);
    if (this.bars.length > this.maxBars) this.bars.splice(0, this.bars.length - this.maxBars);
    this.cur = null;
    return b;
  }
}

export type DivergenceKind = 'bearish' | 'bullish';

/**
 * - `HH_LH`: price makes a higher high, CVD a lower high → bearish.
 * - `LL_HL`: price makes a lower low, CVD a higher low → bullish.
 * - `CVD_HH`: CVD makes a higher high but price does not (buying absorbed) → bearish.
 * - `CVD_LL`: CVD makes a lower low but price does not (selling absorbed) → bullish.
 */
export type DivergenceCode = 'HH_LH' | 'LL_HL' | 'CVD_HH' | 'CVD_LL';

export interface DivergenceSignal {
  code: DivergenceCode;
  kind: DivergenceKind;
  /** Open time of the signal bar. */
  t: number;
  tfMs: number;
  /** Price of the extreme involved (bar high for bearish, bar low for bullish), ticks. */
  px: number;
  cvd: number;
}

export interface DivergenceOptions {
  /** Bars before the signal bar that define the prior swing. */
  lookback: number;
  /** Also report CVD-led divergences (absorption at highs / lows). */
  absorption: boolean;
}

export const DEFAULT_DIVERGENCE: DivergenceOptions = { lookback: 10, absorption: false };

export function normalizeDivergenceOptions(raw: Partial<Record<string, unknown>> = {}) {
  const lb = typeof raw.lookback === 'number' && Number.isFinite(raw.lookback) ? raw.lookback : 10;
  return {
    lookback: Math.min(100, Math.max(2, Math.round(lb))),
    absorption: raw.absorption === true,
  } satisfies DivergenceOptions;
}

/** Signals produced by bar `i` against the `lookback` bars before it. */
export function divergenceAt(
  bars: readonly CvdBar[],
  i: number,
  tfMs: number,
  o: DivergenceOptions = DEFAULT_DIVERGENCE,
): DivergenceSignal[] {
  const lb = Math.max(2, o.lookback);
  if (i < lb || i >= bars.length) return [];
  let ph = Number.NEGATIVE_INFINITY;
  let pl = Number.POSITIVE_INFINITY;
  let ch = Number.NEGATIVE_INFINITY;
  let cl = Number.POSITIVE_INFINITY;
  for (let k = i - lb; k < i; k++) {
    const b = bars[k]!;
    if (b.h > ph) ph = b.h;
    if (b.l < pl) pl = b.l;
    if (b.cvdHigh > ch) ch = b.cvdHigh;
    if (b.cvdLow < cl) cl = b.cvdLow;
  }
  const b = bars[i]!;
  const out: DivergenceSignal[] = [];
  const sig = (code: DivergenceCode, kind: DivergenceKind, px: number, cvd: number) =>
    out.push({ code, kind, t: b.t, tfMs, px, cvd });
  if (b.h > ph && b.cvdHigh < ch) sig('HH_LH', 'bearish', b.h, b.cvdHigh);
  if (b.l < pl && b.cvdLow > cl) sig('LL_HL', 'bullish', b.l, b.cvdLow);
  if (o.absorption) {
    if (b.cvdHigh > ch && b.h < ph) sig('CVD_HH', 'bearish', b.h, b.cvdHigh);
    if (b.cvdLow < cl && b.l > pl) sig('CVD_LL', 'bullish', b.l, b.cvdLow);
  }
  return out;
}

/**
 * Every divergence in a bar series, newest first. A condition that repeats on consecutive bars
 * (a trend grinding on) is reported once, at the first bar of the streak.
 */
export function scanDivergences(
  bars: readonly CvdBar[],
  tfMs: number,
  o: DivergenceOptions = DEFAULT_DIVERGENCE,
): DivergenceSignal[] {
  const out: DivergenceSignal[] = [];
  let prev = new Set<DivergenceCode>();
  for (let i = 0; i < bars.length; i++) {
    const s = divergenceAt(bars, i, tfMs, o);
    const now = new Set(s.map((x) => x.code));
    for (const x of s) if (!prev.has(x.code)) out.push(x);
    prev = now;
  }
  return out.reverse();
}

/** "Price HH · CVD LH" style condition text; `fmt` formats a price in ticks. */
export function conditionText(s: DivergenceSignal, fmt: (px: number) => string): string {
  switch (s.code) {
    case 'HH_LH':
      return `Price HH ${fmt(s.px)} · CVD LH`;
    case 'LL_HL':
      return `Price LL ${fmt(s.px)} · CVD HL`;
    case 'CVD_HH':
      return `CVD HH · Price LH ${fmt(s.px)}`;
    case 'CVD_LL':
      return `CVD LL · Price HL ${fmt(s.px)}`;
  }
}

export const DIVERGENCE_TIMEFRAMES = [
  { id: 'M1', ms: 60_000 },
  { id: 'M5', ms: 300_000 },
  { id: 'M15', ms: 900_000 },
  { id: 'H1', ms: 3_600_000 },
] as const;

export function tfLabel(ms: number): string {
  return DIVERGENCE_TIMEFRAMES.find((t) => t.ms === ms)?.id ?? `${ms / 60_000}m`;
}
