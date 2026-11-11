/** News stream model and HT Flow's own market-event detectors (pure; fed by the UI from MarketStores). */

export type NewsKind = 'rss' | 'calendar' | 'big-trade' | 'liquidity-pull' | 'delta-spike';
export type Sentiment = 'bull' | 'bear' | 'neutral' | 'info' | 'warning';
export type NewsCategory = 'crypto' | 'futures' | 'macro' | 'other';

export interface NewsItem {
  id: string;
  t: number;
  kind: NewsKind;
  title: string;
  /** "Binance announcements", "HT Flow metrics", "Calendar". */
  source: string;
  /** Tag labels (tickers / roots). */
  symbols: string[];
  /** Instrument roots used for "My symbols" / active-instrument filtering. */
  roots: string[];
  category: NewsCategory;
  sentiment: Sentiment;
  link?: string;
  sample?: boolean;
}

export type NewsChip = 'all' | 'crypto' | 'futures' | 'macro' | 'mine';

export interface NewsFilter {
  chip: NewsChip;
  /** Roots of the user's symbols (open instruments / watchlist). */
  mySymbols: readonly string[];
  /** Only items tagged with this root (link-group / active window filter). */
  instrumentRoot?: string | null;
  /** Free-text search (title / source / symbols). */
  query?: string;
}

export function filterNews(items: readonly NewsItem[], f: NewsFilter): NewsItem[] {
  const q = f.query?.trim().toLowerCase() ?? '';
  const mine = new Set(f.mySymbols.map((s) => s.toUpperCase()));
  return items.filter((i) => {
    if (f.chip === 'crypto' && i.category !== 'crypto') return false;
    if (f.chip === 'futures' && i.category !== 'futures') return false;
    if (f.chip === 'macro' && i.category !== 'macro') return false;
    if (f.chip === 'mine' && !i.roots.some((r) => mine.has(r))) return false;
    if (f.instrumentRoot && !i.roots.includes(f.instrumentRoot.toUpperCase())) return false;
    if (q) {
      const hay = `${i.title} ${i.source} ${i.symbols.join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** Category from tag classes: crypto wins, then futures, then macro. */
export function categoryOf(classes: readonly string[], folder = ''): NewsCategory {
  if (classes.includes('crypto') || /crypto/i.test(folder)) return 'crypto';
  if (classes.includes('future') || /commodit|futures/i.test(folder)) return 'futures';
  if (classes.includes('macro') || /central bank|regulator|macro/i.test(folder)) return 'macro';
  return 'other';
}

const BULL =
  /\b(surge|soar|jump|rall(y|ies)|gain|beat|record high|launch|listing|approv|upgrade|rises?|higher|cut rates?|rate cut)\b/i;
const BEAR =
  /\b(plunge|slump|fall|drop|tumble|miss|delist|halt|suspend|hack|exploit|downgrade|probe|lawsuit|fine[ds]?|ban|lower|hike|outage|maintenance)\b/i;

/** Very small headline sentiment heuristic (dot colour only — never a trading signal). */
export function headlineSentiment(title: string): Sentiment {
  const b = BULL.test(title);
  const r = BEAR.test(title);
  if (b && !r) return 'bull';
  if (r && !b) return 'bear';
  return 'neutral';
}

/** Merges streams newest-first, de-duplicating by id, capped to `max`. */
export function mergeNews(lists: readonly (readonly NewsItem[])[], max = 500): NewsItem[] {
  const seen = new Set<string>();
  const out: NewsItem[] = [];
  for (const l of lists)
    for (const i of l) {
      if (seen.has(i.id)) continue;
      seen.add(i.id);
      out.push(i);
    }
  return out.sort((a, b) => b.t - a.t).slice(0, max);
}

// ---------------------------------------------------------------- detectors

export interface TradeLike {
  ts: number;
  px: number;
  qty: number;
  side: 'buy' | 'sell' | 'unknown';
}

export interface DetectorEvent {
  kind: 'big-trade' | 'delta-spike' | 'liquidity-pull';
  t: number;
  /** Price in ticks (where relevant). */
  px?: number;
  qty: number;
  side: 'buy' | 'sell' | 'unknown';
  /** Size relative to the running baseline (e.g. 12.4× average). */
  ratio: number;
}

/**
 * Big prints: a trade ≥ max(minQty, multiple × EWMA of trade size). The baseline warms up on the
 * first `warmup` trades (no events before that) and excludes the big prints themselves.
 */
export class BigTradeDetector {
  private avg = 0;
  private n = 0;
  private lastAt = -Infinity;

  constructor(
    public multiple = 25,
    public minQty = 0,
    public cooldownMs = 2000,
    private warmup = 200,
    private alpha = 0.01,
  ) {}

  push(trades: readonly TradeLike[]): DetectorEvent[] {
    const out: DetectorEvent[] = [];
    for (const t of trades) {
      if (!(t.qty > 0)) continue;
      const ready = this.n >= this.warmup && this.avg > 0;
      const big = ready && t.qty >= Math.max(this.minQty, this.multiple * this.avg);
      if (big) {
        if (t.ts - this.lastAt >= this.cooldownMs) {
          out.push({
            kind: 'big-trade',
            t: t.ts,
            px: t.px,
            qty: t.qty,
            side: t.side,
            ratio: t.qty / this.avg,
          });
          this.lastAt = t.ts;
        }
        continue;
      }
      this.n++;
      this.avg = this.n === 1 ? t.qty : this.avg + this.alpha * (t.qty - this.avg);
    }
    return out;
  }
}

/**
 * Delta spikes: net aggressive volume (buy − sell) over a rolling window vs the mean absolute
 * window delta of the previous windows. Fires when |delta| ≥ multiple × baseline.
 */
export class DeltaSpikeDetector {
  private windowStart = Number.NaN;
  private delta = 0;
  private history: number[] = [];
  private lastAt = -Infinity;

  constructor(
    public windowMs = 10_000,
    public multiple = 6,
    private baselineWindows = 60,
    private minWindows = 12,
    public cooldownMs = 30_000,
  ) {}

  private close(at: number, out: DetectorEvent[]) {
    const h = this.history;
    if (h.length >= this.minWindows) {
      const base = h.reduce((a, b) => a + Math.abs(b), 0) / h.length;
      if (
        base > 0 &&
        Math.abs(this.delta) >= this.multiple * base &&
        at - this.lastAt >= this.cooldownMs
      ) {
        out.push({
          kind: 'delta-spike',
          t: at,
          qty: Math.abs(this.delta),
          side: this.delta > 0 ? 'buy' : 'sell',
          ratio: Math.abs(this.delta) / base,
        });
        this.lastAt = at;
      }
    }
    h.push(this.delta);
    if (h.length > this.baselineWindows) h.shift();
    this.delta = 0;
  }

  push(trades: readonly TradeLike[]): DetectorEvent[] {
    const out: DetectorEvent[] = [];
    for (const t of trades) {
      if (Number.isNaN(this.windowStart)) this.windowStart = t.ts;
      while (t.ts >= this.windowStart + this.windowMs) {
        this.windowStart += this.windowMs;
        this.close(this.windowStart, out);
      }
      if (t.side === 'buy') this.delta += t.qty;
      else if (t.side === 'sell') this.delta -= t.qty;
    }
    return out;
  }
}

export interface DepthLike {
  t: number;
  bestBid: number;
  bestAsk: number;
  pxs: ArrayLike<number>;
  qtys: ArrayLike<number>;
}

/**
 * Liquidity pulls: a large resting level near the inside (≥ multiple × median level size, within
 * `nearTicks` of the touch) that loses ≥ `dropFrac` of its size between two depth samples while
 * the touch did not trade through it (so the size was cancelled, not filled).
 */
export class LiquidityPullDetector {
  private prev: DepthLike | null = null;
  private lastAt = new Map<number, number>();

  constructor(
    public multiple = 5,
    public nearTicks = 20,
    public dropFrac = 0.7,
    public cooldownMs = 15_000,
  ) {}

  /** `tradedAt(px)` = volume traded at that price between the two samples. */
  push(col: DepthLike, tradedAt: (px: number) => number = () => 0): DetectorEvent[] {
    const prev = this.prev;
    this.prev = col;
    if (!prev || !Number.isFinite(prev.bestBid) || !Number.isFinite(col.bestBid)) return [];
    const sizes: number[] = [];
    for (let i = 0; i < prev.qtys.length; i++) if (prev.qtys[i]! > 0) sizes.push(prev.qtys[i]!);
    if (sizes.length < 10) return [];
    sizes.sort((a, b) => a - b);
    const median = sizes[sizes.length >> 1]!;
    const now = new Map<number, number>();
    for (let i = 0; i < col.pxs.length; i++) now.set(col.pxs[i]!, col.qtys[i]!);
    const out: DetectorEvent[] = [];
    for (let i = 0; i < prev.pxs.length; i++) {
      const px = prev.pxs[i]!;
      const q = prev.qtys[i]!;
      if (q < this.multiple * median) continue;
      const isBid = px <= prev.bestBid;
      const dist = isBid ? prev.bestBid - px : px - prev.bestAsk;
      if (dist < 0 || dist > this.nearTicks) continue;
      // Price moved through the level → consumed, not pulled.
      if (isBid ? col.bestBid < px : col.bestAsk > px) continue;
      const after = now.get(px) ?? 0;
      const removed = q - after;
      if (removed < q * this.dropFrac) continue;
      if (tradedAt(px) >= removed * 0.5) continue;
      if (col.t - (this.lastAt.get(px) ?? -Infinity) < this.cooldownMs) continue;
      this.lastAt.set(px, col.t);
      out.push({
        kind: 'liquidity-pull',
        t: col.t,
        px,
        qty: removed,
        side: isBid ? 'buy' : 'sell',
        ratio: q / median,
      });
    }
    return out;
  }
}
