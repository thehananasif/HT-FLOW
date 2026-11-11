import {
  DeltaLog,
  type ReplayDataInfo,
  type ReplayDataSource,
  type ReplayDataset,
  type ReplayLayers,
} from '@htflow/replay';
import type { Instrument, Trade } from '@htflow/market-data';
import { isTauri } from '../backend';
import { instrumentById } from '../state/instruments';
import { registerReplaySource } from './replay';
import { dataApi, type InstrumentSummary } from '../modules/data-manager/api';

/**
 * Replay data from the local tick store (P06 → P24): recorded trades plus the 250 ms
 * top-of-book snapshots. Registered as the preferred source in the desktop app.
 */
class TickStoreSource implements ReplayDataSource {
  readonly id = 'tick-store';
  readonly label = 'Tick store (recorded on this PC)';
  private listing = new Map<string, InstrumentSummary>();
  private loaded: Promise<void> | null = null;

  refresh(): Promise<void> {
    this.loaded = dataApi
      .list()
      .then((l) => {
        this.listing = new Map(l.map((i) => [i.instrument, i]));
      })
      .catch(() => undefined);
    return this.loaded;
  }

  covers(instrumentId: string): boolean {
    if (!this.loaded) void this.refresh();
    const s = this.listing.get(instrumentId);
    return !!s && s.trades > 1;
  }

  async range(instrumentId: string): Promise<{ from: number; to: number } | null> {
    await this.refresh();
    const s = this.listing.get(instrumentId);
    return s && s.trades > 1 ? { from: s.firstMs, to: s.lastMs } : null;
  }

  async info(instrumentId: string, from: number, to: number): Promise<ReplayDataInfo> {
    const s = this.listing.get(instrumentId);
    if (!s) return { where: 'disk', bytes: 0, days: 0, trades: 0 };
    const days = s.days.filter((d) => d.lastMs >= from && d.firstMs <= to);
    return {
      where: 'disk',
      bytes: days.reduce((a, d) => a + d.tradeBytes + d.depthBytes, 0),
      days: s.days.length,
      trades: days.reduce((a, d) => a + d.trades, 0),
      note: `${days.length} recorded day${days.length === 1 ? '' : 's'} in range`,
    };
  }

  async load(
    instrumentId: string,
    from: number,
    to: number,
    layers: ReplayLayers = { ticks: true, depth: true },
  ): Promise<ReplayDataset> {
    const w = await dataApi.replay(instrumentId, from, to, layers.depth);
    const base = instrumentById(instrumentId);
    const [venue, symbol] = instrumentId.split(':');
    const instrument: Instrument = {
      ...(base ?? {
        id: instrumentId,
        symbol: symbol ?? instrumentId,
        displayName: symbol ?? instrumentId,
        exchange: venue ?? 'Tick store',
        assetClass: 'crypto',
        qtyPrecision: 3,
        tickValue: 0,
        currency: 'USDT',
      }),
      tickSize: w.tick_size,
      pricePrecision: w.price_precision,
    } as Instrument;
    const trades: Trade[] = w.trades.map(([ts, px, qty, s, id]) => ({
      ts,
      px,
      qty,
      side: s > 0 ? 'buy' : s < 0 ? 'sell' : 'unknown',
      id,
    }));
    const snapshots = w.snapshots
      .filter(([ts]) => ts > from)
      .map(([ts, bids, asks]) => ({ ts, bids, asks }));
    const first = w.snapshots[0];
    return {
      instrument,
      start: from,
      end: Math.min(to, Math.max(from + 1, trades.at(-1)?.ts ?? to)),
      trades: layers.ticks ? trades : [],
      snapshots,
      deltas: new DeltaLog(1).trim(),
      initialBook: first ? { ts: from, bids: first[1], asks: first[2] } : undefined,
    };
  }
}

if (isTauri) {
  const src = new TickStoreSource();
  registerReplaySource(src, true);
  // Pick up newly recorded days now and then.
  setInterval(() => void src.refresh(), 5 * 60_000);
}
