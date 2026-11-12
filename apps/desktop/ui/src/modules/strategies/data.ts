import type { ReplayDataSource, ReplayDataset, ReplayLayers } from '@htflow/replay';
import { replaySources } from '../../feeds/replay';
import { allInstruments } from '../../state/instruments';
import { isTauri } from '../../backend';

const DAY = 86_400_000;

/** Where backtest history comes from: the replay data-source registry (tick store, simulator, memory). */
export interface DataSetup {
  instrumentId: string;
  /** Replay source id; '' = first that covers the instrument (tick store preferred). */
  source: string;
  /** UTC day as YYYY-MM-DD; '' = the most recent complete day. */
  day: string;
  fromHour: number;
  hours: number;
}

export const DEFAULT_DATA: DataSetup = {
  instrumentId: 'mock:ESZ6',
  source: '',
  day: '',
  fromHour: 0,
  hours: 8,
};

export function sanitizeData(raw: unknown): DataSetup {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<DataSetup>;
  const num = (v: unknown, d: number, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d;
  return {
    instrumentId: typeof r.instrumentId === 'string' ? r.instrumentId : DEFAULT_DATA.instrumentId,
    source: typeof r.source === 'string' ? r.source : '',
    day: typeof r.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.day) ? r.day : '',
    fromHour: num(r.fromHour, 0, 0, 23),
    hours: num(r.hours, 8, 1, 24 * 30),
  };
}

export function lastCompleteDay(now = Date.now()): string {
  return new Date(Math.floor(now / DAY) * DAY - DAY).toISOString().slice(0, 10);
}

export function rangeOf(d: DataSetup, now = Date.now()): { from: number; to: number } {
  const day = Date.parse(`${d.day || lastCompleteDay(now)}T00:00:00Z`);
  const from = day + d.fromHour * 3_600_000;
  return { from, to: Math.min(now, from + d.hours * 3_600_000) };
}

/** Instruments with recorded or simulated history. */
export function backtestInstruments() {
  return allInstruments(isTauri).filter((i) => replaySources(i.id).length > 0);
}

export function sourcesFor(instrumentId: string): ReplayDataSource[] {
  return replaySources(instrumentId);
}

/** Loads history through the replay registry. Depth is only loaded for the book fill model. */
export async function loadHistory(
  d: DataSetup,
  depth: boolean,
  onProgress?: (p: number) => void,
): Promise<{ dataset: ReplayDataset; source: ReplayDataSource }> {
  const all = sourcesFor(d.instrumentId);
  const src = (d.source && all.find((s) => s.id === d.source)) || all[0];
  if (!src) throw new Error(`No recorded or simulated data for ${d.instrumentId}`);
  const { from, to } = rangeOf(d);
  const layers: ReplayLayers = { ticks: true, depth };
  // SimulatedSource takes a progress callback as a fifth argument.
  const load = src.load as (
    id: string,
    from: number,
    to: number,
    layers?: ReplayLayers,
    onProgress?: (p: number) => void,
  ) => Promise<ReplayDataset>;
  const dataset = await load.call(src, d.instrumentId, from, to, layers, onProgress);
  if (!dataset.trades.length) throw new Error('No trades in the selected range');
  return { dataset, source: src };
}
