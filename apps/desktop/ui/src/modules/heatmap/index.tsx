import './styles.css';
import { GRADIENT_LABELS, GRADIENTS } from '@htflow/heatmap';
import { toast } from '@htflow/ui-kit';
import { registerCommands, runCommand, type Command } from '../../shell/commands';
import { registerModule } from '../registry';
import { targetHeatmap, type HeatmapApi } from './api';
import { toolLabel } from '../drawings/toolText';
import { HEATMAP_TOOLS } from './drawings';
import { HeatmapView } from './HeatmapView';
import { COLUMN_WIDTHS, columnLabel, type HeatmapModuleSettings } from './model';

/** P11 Heatmap / Liquidity map — standalone window (ribbon → Heatmap). */
registerModule({ id: 'heatmap', view: HeatmapView });

/** Runs on the target window, opening a Heatmap first when none is open. */
function withHeatmap(fn: (api: HeatmapApi) => void) {
  return () => {
    const api = targetHeatmap();
    if (api) return fn(api);
    runCommand('open.heatmap');
    // The window mounts on the next frames; retry briefly.
    let tries = 0;
    const retry = () => {
      const a = targetHeatmap();
      if (a) fn(a);
      else if (tries++ < 20) setTimeout(retry, 50);
      else toast('info', 'Open a Heatmap window first');
    };
    setTimeout(retry, 50);
  };
}

type BoolKey = {
  [K in keyof HeatmapModuleSettings]: HeatmapModuleSettings[K] extends boolean ? K : never;
}[keyof HeatmapModuleSettings];

const toggle = (id: string, label: string, key: BoolKey, keywords = ''): Command => ({
  id: `heatmap.toggle.${id}`,
  label: `Heatmap: toggle ${label}`,
  group: 'Analysis',
  keywords: `heatmap liquidity ${keywords}`,
  run: withHeatmap((a) => a.patch({ [key]: !a.settings()[key] })),
});

const cmds: Command[] = [
  {
    id: 'heatmap.3d',
    label: 'Heatmap: toggle 3D mode',
    group: 'Analysis',
    keywords: 'heatmap three.js surface orbit',
    run: withHeatmap((a) => a.toggle3d()),
  },
  {
    id: 'heatmap.quickSettings',
    label: 'Heatmap: quick settings',
    group: 'Analysis',
    keywords: 'heatmap settings popover',
    run: withHeatmap((a) => a.quickSettings()),
  },
  {
    id: 'heatmap.fullSettings',
    label: 'Heatmap: open full settings',
    group: 'Analysis',
    keywords: 'heatmap settings dialog',
    run: withHeatmap((a) => a.fullSettings()),
  },
  toggle('heat', 'heat texture', 'heat'),
  toggle('bubbles', 'trade bubbles', 'bubbles', 'trades'),
  toggle('bba', 'best bid / ask lines', 'bestBidAsk', 'bbo'),
  toggle('dom', 'Depth of Market column', 'domColumn', 'dom book'),
  toggle('volume', 'volume bars', 'volume', 'delta'),
  toggle('large', 'large-order outlines', 'largeOrders', 'walls'),
  toggle('lifetime', 'order lifetime colours', 'lifetime', 'age'),
  toggle('icebergs', 'iceberg markers', 'icebergs', 'hidden'),
  toggle('spoofs', 'spoof flashes', 'spoofs', 'pulled liquidity'),
  toggle('readout', 'crosshair size readout', 'crosshairReadout'),
  {
    id: 'heatmap.normalize',
    label: 'Heatmap: normalise per column / global',
    group: 'Analysis',
    keywords: 'heatmap normalisation',
    run: withHeatmap((a) =>
      a.patch({ normalize: a.settings().normalize === 'column' ? 'global' : 'column' }),
    ),
  },
  ...(['pie', 'dominant', 'plain'] as const).map((st): Command => ({
    id: `heatmap.bubbles.${st}`,
    label: `Heatmap: bubbles ${st === 'pie' ? 'pie (buy/sell)' : st === 'dominant' ? 'dominant side' : 'plain'}`,
    group: 'Analysis',
    keywords: 'heatmap bubble style fill',
    run: withHeatmap((a) => a.patch({ bubbles: true, bubbleStyle: st })),
  })),
  ...(['volume', 'delta'] as const).map((c): Command => ({
    id: `heatmap.volumeCalc.${c}`,
    label: `Heatmap: volume bars by ${c}`,
    group: 'Analysis',
    run: withHeatmap((a) => a.patch({ volume: true, volumeCalc: c })),
  })),
  ...(['linear', 'log', 'sqrt'] as const).map((sc): Command => ({
    id: `heatmap.scale.${sc}`,
    label: `Heatmap: ${sc} scale`,
    group: 'Analysis',
    keywords: 'heatmap scale intensity',
    run: withHeatmap((a) => a.patch({ scale: sc })),
  })),
  ...(['volume', 'delta'] as const).map((c): Command => ({
    id: `heatmap.bubbleCalc.${c}`,
    label: `Heatmap: bubbles sized by ${c}`,
    group: 'Analysis',
    run: withHeatmap((a) => a.patch({ bubbles: true, bubbleCalc: c })),
  })),
  {
    id: 'heatmap.bbaMode',
    label: 'Heatmap: best bid / ask as separate lines or mid',
    group: 'Analysis',
    run: withHeatmap((a) =>
      a.patch({ bestBidAsk: true, bbaMode: a.settings().bbaMode === 'mid' ? 'bid-ask' : 'mid' }),
    ),
  },
  ...Object.keys(GRADIENTS).map((g): Command => ({
    id: `heatmap.gradient.${g}`,
    label: `Heatmap: colour ${GRADIENT_LABELS[g] ?? g}`,
    group: 'Analysis',
    keywords: 'heatmap gradient palette colour',
    run: withHeatmap((a) => a.patch({ gradient: g })),
  })),
  ...COLUMN_WIDTHS.map((ms): Command => ({
    id: `heatmap.column.${ms}`,
    label: `Heatmap: column width ${columnLabel(ms)}`,
    group: 'Analysis',
    keywords: 'heatmap time column resolution',
    run: withHeatmap((a) => a.column(ms)),
  })),
  {
    id: 'heatmap.stress',
    label: 'Heatmap: run 30 fps stress test',
    group: 'Analysis',
    keywords: 'heatmap performance benchmark replay fps',
    run: withHeatmap((a) => a.stress()),
  },
  {
    id: 'heatmap.resetView',
    label: 'Heatmap: go to latest / reset view',
    group: 'Analysis',
    run: withHeatmap((a) => a.resetView()),
  },
  {
    id: 'heatmap.resetSettings',
    label: 'Heatmap: reset settings to defaults',
    group: 'Analysis',
    run: withHeatmap((a) => a.resetSettings()),
  },
  {
    id: 'heatmap.snapshot',
    label: 'Heatmap: export PNG',
    group: 'Analysis',
    keywords: 'heatmap screenshot image',
    run: withHeatmap((a) => a.snapshot()),
  },
  ...HEATMAP_TOOLS.map((t): Command => ({
    id: `heatmap.draw.${t.id}`,
    label: `Heatmap: draw ${toolLabel(t.id)}`,
    group: 'Drawing',
    keywords: 'heatmap drawing tool',
    run: withHeatmap((a) => a.tool(t.id)),
  })),
  {
    id: 'heatmap.objects',
    label: 'Heatmap: objects list',
    group: 'Drawing',
    run: withHeatmap((a) => a.objects()),
  },
];

registerCommands(cmds);
