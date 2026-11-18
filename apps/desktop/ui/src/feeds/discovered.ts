import { MockFeed, type Instrument } from '@htflow/market-data';
import type { WindowState } from '@htflow/workspace';
import { registerFeedProvider } from './registry';
import { isTauri } from '../backend';
import { TauriLiveFeed } from '../state/liveFeed';
import { LIVE_INSTRUMENTS } from '../state/instruments';
import {
  discoveredExtras,
  discoveredFeed,
  onDiscoveryApplied,
  refreshSymbolLists,
  registerBuiltInFeeds,
  startInstrumentDiscovery,
  useDiscovery,
  withDiscovered,
} from '../state/discovery';
import { registerCommands } from '../shell/commands';
import { useWindows } from '../state/windows';
import { openWindow } from '../modules/workspaces/windowActions';
import { newChartState } from '../charts/settings/globals';
import { toast } from '@htflow/ui-kit';

import { translateLiteral as tl, tt } from '@htflow/i18n';
/**
 * Binance USDⓈ-M futures beyond the six built-in symbols (state/instruments.ts LIVE_INSTRUMENTS):
 * every discovered symbol, including dated quarterlies, opens a live feed.
 */
registerBuiltInFeeds('binance-futures', LIVE_INSTRUMENTS);

registerFeedProvider({
  prefix: 'binance-futures:',
  label: 'Binance Futures',
  desktopOnly: true,
  // The six built-in rows are listed by state/instruments.ts already.
  instruments: () => withDiscovered('binance-futures', []),
  create(id) {
    const inst: Instrument | undefined =
      LIVE_INSTRUMENTS.find((i) => i.id === id) ?? discoveredFeed(id);
    if (!inst) throw new Error(`Unknown instrument ${id}`);
    if (isTauri) return new TauriLiveFeed({ ...inst }, 'binance-futures');
    // Browser preview has no native connectors; fall back to a simulator.
    return new MockFeed('BTCUSDT');
  },
});

// ------------------------------------------------------------------ palette

registerCommands([
  {
    id: 'instruments.refreshSymbols',
    label: 'Refresh symbol list (all exchanges)',
    group: 'Instrument',
    keywords: 'symbols coins instruments exchange info discovery reload update venues',
    run: () => {
      void refreshSymbolLists().then((r) => {
        const err = useDiscovery.getState().error;
        if (err) toast('error', tl('Symbol list refresh failed'), err);
        else if (r) {
          const total = r.sources.reduce((n, s) => n + s.count, 0);
          const failed = r.sources.filter((s) => !s.ok).map((s) => s.label);
          toast(
            failed.length ? 'warning' : 'success',
            tt`${total.toLocaleString()} symbols from ${r.sources.length} sources`,
            failed.length ? `Not reachable: ${failed.join(', ')} (kept the last list)` : undefined,
          );
        } else
          toast(
            'info',
            tl('Symbol lists'),
            tl('The browser preview uses the built-in list (no CORS).'),
          );
      });
    },
  },
]);

let unregister: (() => void) | null = null;

/** Every discovered symbol can be opened from the Command Palette. */
function registerInstrumentCommands(): void {
  unregister?.();
  if (!isTauri) {
    unregister = null;
    return;
  }
  unregister = registerCommands(
    discoveredExtras().map((i) => ({
      id: `inst.${i.id}`,
      label: `${i.symbol} — ${i.exchange}`,
      group: 'Instrument' as const,
      keywords: i.displayName,
      run: () => {
        const { activeId, patch } = useWindows.getState();
        if (activeId) patch(activeId, { instrumentId: i.id } as Partial<WindowState>);
        else openWindow({ state: newChartState(i.id, 'footprint') });
      },
    })),
  );
}

onDiscoveryApplied(registerInstrumentCommands);

void startInstrumentDiscovery();
