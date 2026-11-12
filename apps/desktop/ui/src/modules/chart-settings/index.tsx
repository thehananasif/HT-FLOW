/**
 * Chart settings (P34) + chart header items (pin, compare). Registered as a chart extension so the
 * floating settings window renders for the chart it was opened from (Ctrl+S, right-click → Settings…,
 * header gear).
 */
import { GitCompareArrows, Pin, PinOff } from 'lucide-react';
import { IconButton } from '@htflow/ui-kit';
import type { ChartWindowState } from '@htflow/workspace';
import { registerChartExtension, registerHeaderItem } from '../../charts/extensions';
import { useChartSettingsUi } from '../../charts/settingsUi';
import { extState, patchChartExt } from '../../charts/settings/state';
import { chartAction } from '../../charts/bus';
import { ChartSettingsWindow } from './ChartSettingsWindow';
import './styles.css';

function SettingsOverlay({ windowId }: { windowId: string; state: ChartWindowState }) {
  const openFor = useChartSettingsUi((s) => s.openFor);
  return openFor === windowId ? <ChartSettingsWindow windowId={windowId} /> : null;
}

registerChartExtension({ id: 'chart-settings', Overlay: SettingsOverlay });

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
