import type { BarSeries, DepthColumn, Trade } from '@htflow/market-data';
import type { SlotSource } from './types';

export function barSource(series: BarSeries): SlotSource {
  return { count: () => series.bars.length, timeAt: (i) => series.bars[i]?.t ?? 0 };
}

/** Depth columns sampled every `stride` base columns (250 ms → 1 s / 5 s). */
export function depthSource(getDepth: () => DepthColumn[], stride = 1): SlotSource {
  return {
    count: () => Math.ceil(getDepth().length / stride),
    timeAt: (i) => getDepth()[Math.min(getDepth().length - 1, i * stride)]?.t ?? 0,
  };
}

export function tradeSource(getTrades: () => Trade[]): SlotSource {
  return { count: () => getTrades().length, timeAt: (i) => getTrades()[i]?.ts ?? 0 };
}
