export type ActivityType =
  'fill' | 'bracket' | 'cancel' | 'reject' | 'risk' | 'lock' | 'connection' | 'alert' | 'info';

export interface ActivityEvent {
  id: string;
  ts: number;
  type: ActivityType;
  /** Account or connection label. */
  account: string;
  message: string;
}

export const ACTIVITY_KEEP_MS = 90 * 86_400_000;
export const ACTIVITY_CAP = 5000;

/** Drops events older than 90 days and keeps the newest `cap` (rolling). */
export function pruneActivity(
  list: ActivityEvent[],
  now: number,
  cap = ACTIVITY_CAP,
): ActivityEvent[] {
  const kept = list.filter((e) => now - e.ts <= ACTIVITY_KEEP_MS);
  return kept.length > cap ? kept.slice(kept.length - cap) : kept;
}
