import { DeltaLog } from '@htflow/replay';
import type { BookSnapshot, Trade } from '@htflow/market-data';
import type { BacktestData } from './backtest';

/** Structured-clone friendly dataset (for Web Workers): the delta log as plain typed arrays. */
export interface PlainData {
  start: number;
  end: number;
  trades: Trade[];
  snapshots: BookSnapshot[];
  initialBook?: BookSnapshot;
  deltas: { ts: Float64Array; px: Int32Array; qty: Float64Array; side: Uint8Array; length: number };
}

export function toPlainData(d: BacktestData): PlainData {
  const n = d.deltas.length;
  return {
    start: d.start,
    end: d.end,
    trades: d.trades,
    snapshots: d.snapshots,
    initialBook: d.initialBook,
    deltas: {
      ts: d.deltas.ts.slice(0, n),
      px: d.deltas.px.slice(0, n),
      qty: d.deltas.qty.slice(0, n),
      side: d.deltas.side.slice(0, n),
      length: n,
    },
  };
}

export function fromPlainData(p: PlainData): BacktestData {
  const log = new DeltaLog(1);
  log.ts = p.deltas.ts;
  log.px = p.deltas.px;
  log.qty = p.deltas.qty;
  log.side = p.deltas.side;
  log.length = p.deltas.length;
  return {
    start: p.start,
    end: p.end,
    trades: p.trades,
    snapshots: p.snapshots,
    initialBook: p.initialBook,
    deltas: log,
  };
}
