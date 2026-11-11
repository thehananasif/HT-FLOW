/** Time-axis helpers: bar countdown, time-zone offsets and gap (time-proportional) positioning. */

/** Milliseconds until the bar opened at `barOpen` (period `periodMs`) closes; 0 when closed. */
export function barRemainingMs(barOpen: number, periodMs: number, now: number): number {
  if (!(periodMs > 0)) return 0;
  // A bar that is already past its close keeps counting the *current* period.
  let close = barOpen + periodMs;
  if (now >= close) close = Math.floor(now / periodMs) * periodMs + periodMs;
  return Math.max(0, close - now);
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** "mm:ss" below one hour, "h:mm:ss" below one day, "Nd hh:mm" above. */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${pad2(h)}:${pad2(m)}`;
  if (h > 0) return `${h}:${pad2(m)}:${pad2(sec)}`;
  return `${pad2(m)}:${pad2(sec)}`;
}

/** Countdown label for the bar opened at barOpen; null for non-time bars. */
export function countdownLabel(
  barOpen: number | undefined,
  periodMs: number | null,
  now: number,
): string | null {
  if (barOpen === undefined || !periodMs) return null;
  return formatCountdown(barRemainingMs(barOpen, periodMs, now));
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();

/**
 * Offset of an IANA time zone from UTC in minutes at instant t ("UTC" → 0, "local" → the
 * machine's zone). Invalid zones fall back to 0.
 */
export function zoneOffsetMin(zone: string, t: number): number {
  if (!zone || zone === 'UTC') return 0;
  if (zone === 'local') return -new Date(t).getTimezoneOffset();
  let f = fmtCache.get(zone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      return 0;
    }
    fmtCache.set(zone, f);
  }
  const parts: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(t))) if (p.type !== 'literal') parts[p.type] = +p.value;
  const asUtc = Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day!,
    parts.hour! % 24,
    parts.minute!,
    parts.second!,
  );
  return Math.round((asUtc - Math.floor(t / 1000) * 1000) / 60_000);
}

/** Smallest positive gap between consecutive times (the bar period for time bars). */
export function inferPeriod(timeAt: (i: number) => number, n: number, sample = 200): number {
  let best = Infinity;
  for (let i = Math.max(1, n - sample); i < n; i++) {
    const d = timeAt(i) - timeAt(i - 1);
    if (d > 0 && d < best) best = d;
  }
  return Number.isFinite(best) ? best : 0;
}

/** Index of the last slot with time <= t (binary search, -1 when before the first). */
export function slotAtOrBefore(timeAt: (i: number) => number, n: number, t: number): number {
  let lo = 0;
  let hi = n - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (timeAt(mid) <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/**
 * Virtual (time-proportional) slot positions for "gaps on": slot i sits at
 * (n - 1) - (tLast - t_i) / period, so missing periods leave empty space.
 */
export function virtualSlot(
  timeAt: (i: number) => number,
  n: number,
  i: number,
  period: number,
): number {
  if (n === 0 || !(period > 0)) return i;
  const tl = timeAt(n - 1);
  if (i >= n) return n - 1 + (i - (n - 1));
  if (i < 0) return virtualSlot(timeAt, n, 0, period) + i;
  return n - 1 - (tl - timeAt(i)) / period;
}

/** Inverse of virtualSlot: nearest real slot for a virtual position (binary search). */
export function realSlot(
  timeAt: (i: number) => number,
  n: number,
  vs: number,
  period: number,
): number {
  if (n === 0 || !(period > 0)) return Math.round(vs);
  const tl = timeAt(n - 1);
  if (vs > n - 1) return Math.round(vs);
  const t = tl - (n - 1 - vs) * period;
  const j = slotAtOrBefore(timeAt, n, t);
  if (j < 0) return Math.round(vs - virtualSlot(timeAt, n, 0, period));
  if (j + 1 < n && Math.abs(timeAt(j + 1) - t) < Math.abs(t - timeAt(j))) return j + 1;
  return j;
}
