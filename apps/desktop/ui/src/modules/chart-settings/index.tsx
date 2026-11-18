/**
 * Chart settings (P34) + chart header items (pin, compare). Registered as a chart extension so the
 * floating settings window renders for the chart it was opened from (Ctrl+S, right-click → Settings…,
 * header gear).
 */
import { GitCompareArrows, Pin, PinOff } from 'lucide-react';
import { IconButton, toast } from '@htflow/ui-kit';
import { setSetting } from '../../state/settings';
import type { ChartWindowState } from '@htflow/workspace';
import { registerChartExtension, registerHeaderItem } from '../../charts/extensions';
import { useChartSettingsUi } from '../../charts/settingsUi';
import { extState, patchChartExt } from '../../charts/settings/state';
import { chartAction } from '../../charts/bus';
import { ChartSettingsWindow } from './ChartSettingsWindow';
import {
  FootprintQuickSettings,
  loadPreset,
  useFootprintQuick,
} from '../../charts/FootprintQuickSettings';
import { BUILTIN_PRESETS } from '../../charts/footprintQuick';
import { activeChartId } from '../../charts/bus';
import { registerCommands } from '../../shell/commands';
import './styles.css';

function SettingsOverlay({ windowId }: { windowId: string; state: ChartWindowState }) {
  const openFor = useChartSettingsUi((s) => s.openFor);
  return openFor === windowId ? <ChartSettingsWindow windowId={windowId} /> : null;
}

registerChartExtension({ id: 'chart-settings', Overlay: SettingsOverlay });

function FootprintQuickOverlay({ windowId }: { windowId: string; state: ChartWindowState }) {
  const openFor = useFootprintQuick((s) => s.openFor);
  return openFor === windowId ? <FootprintQuickSettings /> : null;
}

registerChartExtension({ id: 'footprint-quick', Overlay: FootprintQuickOverlay });

registerCommands([
  ...(
    [
      ['auto', 'Auto (WebGL2 on a hardware GPU)'],
      ['webgl2', 'WebGL2 (GPU)'],
      ['canvas2d', 'Canvas 2D'],
    ] as const
  ).map(([value, name]) => ({
    id: `chart.renderer.${value}`,
    label: `Chart: Renderer — ${name}`,
    group: 'Chart' as const,
    keywords: 'gpu webgl canvas backend performance',
    run: () => {
      setSetting('chart.renderer', value);
      toast('info', `Chart renderer: ${name}`);
    },
  })),
  {
    id: 'footprint.quick-settings',
    label: 'Footprint: Quick settings…',
    group: 'Chart',
    scope: 'chart',
    keywords: 'P10 imbalance value area filters presets colours',
    run: () => {
      const id = activeChartId();
      if (id) useFootprintQuick.getState().open(id);
    },
  },
  ...BUILTIN_PRESETS.map((p) => ({
    id: `footprint.preset.${p.id.replace('builtin:', '')}`,
    label: `Footprint: Load preset "${p.name}"`,
    group: 'Chart' as const,
    scope: 'chart' as const,
    run: () => {
      const id = activeChartId();
      if (id) loadPreset(id, p);
    },
  })),
]);

registerHeaderItem({
  id: 'chart-compare',
  order: 50,
  Component: ({ windowId, state }) => {
    const n = extState(state).compare?.length ?? 0;
    return (
      <IconButton
        label={n ? `Compare / overlay (${n})` : 'Compare / overlay instrument'}
        onClick={() => chartAction('overlay', windowId)}
      >
        <GitCompareArrows size={13} />
      </IconButton>
    );
  },
});

registerHeaderItem({
  id: 'chart-pin',
  order: 51,
  Component: ({ windowId, state }) => {
    const pinned = extState(state).pinned === true;
    return (
      <IconButton
        label={
          pinned ? 'Unpin (follow link group)' : 'Pin (keep instrument when the link group changes)'
        }
        aria-pressed={pinned}
        onClick={() => patchChartExt(windowId, { pinned: !pinned })}
      >
        {pinned ? <Pin size={13} /> : <PinOff size={13} />}
      </IconButton>
    );
  },
});
