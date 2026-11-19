import type { Trade } from '@htflow/market-data';
import type { ReplayDataSource, ReplayDataset } from './dataset';

/**
 * "History before start": context drawn before the replay clock's start (P24 / P35). A replay that
 * starts at T shows the bars before T like a normal chart, loaded from the same data source, and
 * only the future (after the clock) stays hidden.
 */
export interface ReplayLookback {
  amount: number;
  unit: 'bars' | 'days';
}

export const DEFAULT_LOOKBACK: ReplayLookback = { amount: 1, unit: 'days' };

const DAY = 86_400_000;
/** Upper bound of the look-back (memory and load time: a simulated day is ~300k ticks). */
export const MAX_LOOKBACK_MS = 5 * DAY;
/** Bar length used to turn "bars" into time when the chart has no time-based bars. */
export const DEFAULT_LOOKBACK_BAR_MS = 5 * 60_000;

/** Validates a persisted look-back; null/garbage → the default, amount 0 → no history. */
export function normalizeLookback(raw: unknown): ReplayLookback {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<ReplayLookback>;
  const unit = r.unit === 'bars' || r.unit === 'days' ? r.unit : DEFAULT_LOOKBACK.unit;
  const max = unit === 'bars' ? 5000 : 5;
  const a = typeof r.amount === 'number' && Number.isFinite(r.amount) ? r.amount : undefined;
  const amount =
    a === undefined
      ? unit === DEFAULT_LOOKBACK.unit
        ? DEFAULT_LOOKBACK.amount
        : 300
      : Math.min(max, Math.max(0, unit === 'bars' ? Math.round(a) : a));
  return { amount, unit };
}

/** Look-back length in ms (bars × bar length, or days), capped at MAX_LOOKBACK_MS. */
export function lookbackMs(lb: ReplayLookback, barMs = DEFAULT_LOOKBACK_BAR_MS): number {
  const n = normalizeLookback(lb);
  const ms = n.unit === 'bars' ? n.amount * Math.max(1000, barMs) : n.amount * DAY;
  return Math.max(0, Math.min(MAX_LOOKBACK_MS, ms));
}

/**
 * [from, to) split at UTC midnights. Day-seeded sources (the simulator) generate every slice from
 * the same day seed as the replay itself, so the look-back joins the replayed data seamlessly.
 */
export function lookbackSlices(from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  let a = from;
  while (a < to) {
    const b = Math.min(to, (Math.floor(a / DAY) + 1) * DAY);
    out.push([a, b]);
    a = b;
  }
  return out;
}

/** Look-back trades that are not already part of `main` (ts before its start / first trade). */
export function lookbackTrades(main: ReplayDataset, pre: readonly Trade[]): Trade[] {
  const first = main.trades[0]?.ts;
  const out: Trade[] = [];
  let last = -Infinity;
  for (const t of pre) {
    if (t.ts > main.start || (t.ts === main.start && first === main.start)) continue;
    if (t.ts < last) continue; // keep time order across slices
    last = t.ts;
    out.push(t);
  }
  return out;
}

/** The replay dataset with look-back trades prepended (the clock still starts at `main.start`). */
export function withLookback(main: ReplayDataset, pre: readonly Trade[]): ReplayDataset {
  const trades = lookbackTrades(main, pre);
  if (!trades.length) return main;
  return { ...main, trades: [...trades, ...main.trades], historyStart: trades[0]!.ts };
}

/**
 * Loads `ms` of trades before `from` from the source, ticks only (the depth before the start is not
 * replayed: the heatmap begins at the start like a recording). Slices the source has no data for
 * are skipped; the result is time-ordered.
 */
export async function loadLookback(
  source: ReplayDataSource,
  instrumentId: string,
  from: number,
  ms: number,
  onProgress?: (p: number) => void,
): Promise<Trade[]> {
  if (!(ms > 0)) return [];
  let start = from - ms;
  const range = await source.range(instrumentId).catch(() => null);
  if (range) start = Math.max(start, range.from);
  if (!(start < from)) return [];
  const slices = lookbackSlices(start, from);
  const out: Trade[] = [];
  const load = source.load.bind(source) as (
    id: string,
    a: number,
    b: number,
    l: { ticks: boolean; depth: boolean },
    p?: (x: number) => void,
  ) => Promise<ReplayDataset>;
  for (const [i, [a, b]] of slices.entries()) {
    try {
      const d = await load(instrumentId, a, b, { ticks: true, depth: false }, (p) =>
        onProgress?.((i + p) / slices.length),
      );
      const lastSlice = i === slices.length - 1;
      for (const t of d.trades) if (t.ts >= a && (t.ts < b || lastSlice)) out.push(t);
    } catch {
      // No data for this slice (gap in the recording): the rest still loads.
    }
    onProgress?.((i + 1) / slices.length);
  }
  return out;
}
