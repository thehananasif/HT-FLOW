import { toast } from '@htflow/ui-kit';
import { DEFAULT_LAYERS } from '@htflow/replay';
import { startReplay, type ReplayConfig } from '../../feeds/replay';
import { log } from '../../state/log';
import { registerCommands } from '../../shell/commands';
import { showReplayOn } from '../replay/ControlBar';

import { translateLiteral as tl } from '@htflow/i18n';
/**
 * "Load sample replay session" (P28): replays one fixed hour of a simulated instrument. The
 * simulator is deterministic by (symbol, UTC day), so this session is identical on every PC and
 * every run — useful for demos, the guided tour and bug reports.
 */
export const SAMPLE_INSTRUMENT = 'mock:CLZ6';
/** 2026-01-05 00:00 → 01:00 UTC. */
export const SAMPLE_FROM = Date.UTC(2026, 0, 5, 0, 0, 0);
export const SAMPLE_TO = SAMPLE_FROM + 60 * 60_000;

export function sampleConfig(): ReplayConfig {
  return {
    instruments: [SAMPLE_INSTRUMENT],
    from: SAMPLE_FROM,
    to: SAMPLE_TO,
    layers: { ...DEFAULT_LAYERS, hideFuture: true },
    source: 'simulated',
  };
}

let loading = false;

export async function loadSampleReplay(): Promise<void> {
  if (loading) return;
  loading = true;
  try {
    toast('info', tl('Loading sample replay…'), tl('Simulated CLZ6, one fixed hour'));
    const s = await startReplay(sampleConfig());
    showReplayOn([...s.engines.keys()]);
    log.info('replay', 'Sample replay session loaded (CLZ6, 2026-01-05 00:00–01:00 UTC)');
    toast('success', tl('Sample replay ready'), tl('Press Space on the chart to play'));
  } catch (e) {
    log.error('replay', `Sample replay failed: ${e instanceof Error ? e.message : String(e)}`);
    toast('error', tl('Sample replay failed'), e instanceof Error ? e.message : String(e));
  } finally {
    loading = false;
  }
}

registerCommands([
  {
    id: 'replay.load-sample',
    label: 'Load sample replay session',
    group: 'Replay',
    keywords: 'demo example simulated history playback fixed seeded hour',
    run: () => void loadSampleReplay(),
  },
]);
