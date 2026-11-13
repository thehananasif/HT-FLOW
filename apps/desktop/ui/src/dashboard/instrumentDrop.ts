/**
 * Drag an instrument from the Instrument Picker onto the dock (P04): dropping on a window changes
 * that window's symbol; Ctrl+drop, or dropping on an empty part of the dock, opens a new chart.
 */
import type { WindowState } from '@htflow/workspace';

export const INSTRUMENT_MIME = 'application/x-htflow-instrument';

export interface InstrumentDragPayload {
  /** Feed id the window should switch to. */
  feedId: string;
  /** Picker entry key (catalog id or feed id), for display. */
  key: string;
}

export function encodePayload(p: InstrumentDragPayload): string {
  return JSON.stringify(p);
}

export function decodePayload(raw: string | undefined | null): InstrumentDragPayload | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<InstrumentDragPayload>;
    return typeof o.feedId === 'string' && o.feedId
      ? { feedId: o.feedId, key: typeof o.key === 'string' ? o.key : o.feedId }
      : null;
  } catch {
    return null;
  }
}

export type DropAction =
  { kind: 'newChart'; feedId: string } | { kind: 'retarget'; windowId: string; feedId: string };

/** Decides what a drop does; `targetId` is the window under the cursor (null = empty dock). */
export function resolveDrop(
  payload: InstrumentDragPayload,
  opts: { ctrl: boolean; targetId: string | null },
): DropAction {
  if (opts.ctrl || !opts.targetId) return { kind: 'newChart', feedId: payload.feedId };
  return { kind: 'retarget', windowId: opts.targetId, feedId: payload.feedId };
}

/** The state patch that points a window at `feedId` (modules keep it in their params). */
export function retargetPatch(w: WindowState, feedId: string): Partial<WindowState> {
  return w.kind === 'module'
    ? ({ params: { ...(w.params ?? {}), instrumentId: feedId } } as Partial<WindowState>)
    : ({ instrumentId: feedId } as Partial<WindowState>);
}
