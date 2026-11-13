/**
 * Chart snapshots (P31 template menu): a saved copy of one chart's whole state — instrument,
 * template, timeframe, footprint mode, settings, indicators and drawings — restored in one click.
 * Pure model here; the store (per profile) is in snapshotStore.ts.
 */
import type { ChartWindowState } from '@htflow/workspace';

export const MAX_SNAPSHOTS = 40;

export interface ChartSnapshot {
  id: string;
  name: string;
  createdAt: number;
  state: ChartWindowState;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "BTCUSDT · 12 Nov 14:05" */
export function snapshotName(symbol: string, at: number): string {
  const d = new Date(at);
  const mon = d.toLocaleString('en-GB', { month: 'short' });
  return `${symbol} · ${d.getDate()} ${mon} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function makeSnapshot(
  s: ChartWindowState,
  symbol: string,
  at = Date.now(),
  id = `snap-${at.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
): ChartSnapshot {
  return { id, name: snapshotName(symbol, at), createdAt: at, state: structuredClone(s) };
}

/** Newest first; capped at MAX_SNAPSHOTS. */
export function addSnapshot(list: readonly ChartSnapshot[], snap: ChartSnapshot): ChartSnapshot[] {
  return [snap, ...list.filter((x) => x.id !== snap.id)].slice(0, MAX_SNAPSHOTS);
}

export function removeSnapshot(list: readonly ChartSnapshot[], id: string): ChartSnapshot[] {
  return list.filter((x) => x.id !== id);
}

/** What restoring a snapshot changes on a chart window: everything but its link group. */
export function restorePatch(cur: ChartWindowState, snap: ChartSnapshot): ChartWindowState {
  return { ...structuredClone(snap.state), kind: 'chart', link: cur.link };
}

/** Validates stored snapshots (drops anything malformed). */
export function parseSnapshots(raw: unknown): ChartSnapshot[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (x): x is ChartSnapshot =>
        !!x &&
        typeof x === 'object' &&
        typeof (x as ChartSnapshot).id === 'string' &&
        typeof (x as ChartSnapshot).name === 'string' &&
        typeof (x as ChartSnapshot).createdAt === 'number' &&
        !!(x as ChartSnapshot).state &&
        (x as ChartSnapshot).state.kind === 'chart' &&
        typeof (x as ChartSnapshot).state.instrumentId === 'string',
    )
    .slice(0, MAX_SNAPSHOTS);
}
