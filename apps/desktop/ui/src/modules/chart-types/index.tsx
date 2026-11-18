import { create } from 'zustand';
import { SlidersHorizontal } from 'lucide-react';
import type { ChartLayer } from '@htflow/chart-engine';
import { t } from '@htflow/i18n';
import { INTERVAL_GROUPS, TIMEFRAME_PRESETS, specKey, type BarSpec } from '@htflow/market-data';
import { CHART_TEMPLATES, type ChartWindowState, type WindowState } from '@htflow/workspace';
import { registerChartExtension, type ChartExtensionContext } from '../../charts/extensions';
import { KagiLayer, PnfLayer } from '../../charts/layers/chartTypeLayers';
import { CT_EXT, readChartTypeSettings } from '../../charts/layers/settings';
import { EXTRA_TEMPLATES } from '../../charts/layers/templates';
import '../../charts/layers/sessions';
import {
  CustomIntervalDialogHost,
  QuickIntervalHost,
  applyTimeframe,
  openCustomInterval,
  specName,
} from '../../charts/timeframes/IntervalMenu';
import { TimeframeDialogHost } from '../../charts/timeframes/TimeframeDialog';
import { openTimeframeDialog, useTimeframes, withSession } from '../../charts/timeframes/presets';
import { useWindows } from '../../state/windows';
import { registerCommands } from '../../shell/commands';
import { ChartTypeSettingsDialog, hasTypeSettings } from './SettingsDialog';
import { CotBar } from './CotBar';
import { useCot } from '../../state/cot';
import '../../charts/timeframes/timeframes.css';

function activeChart(): string | null {
  const { activeId, windows } = useWindows.getState();
  if (activeId && windows[activeId]?.kind === 'chart') return activeId;
  return Object.keys(windows).find((k) => windows[k]!.kind === 'chart') ?? null;
}

function patchActive(fn: (s: ChartWindowState) => Partial<ChartWindowState>): void {
  const id = activeChart();
  const s = id ? useWindows.getState().windows[id] : undefined;
  if (!id || s?.kind !== 'chart') return;
  useWindows.getState().patch(id, fn(s) as Partial<WindowState>);
}

/** P&F and Kagi need their own renderers; other price-based types draw as candles. */
function chartTypeLayers(ctx: ChartExtensionContext): ChartLayer[] {
  const series = ctx.series();
  if (!series) return [];
  const spec = series.spec;
  if (spec.kind !== 'pnf' && spec.kind !== 'kagi') return [];
  for (const l of ctx.core.layers)
    if (l.id === 'candles') (l as unknown as { mode: string }).mode = 'hidden';
  const get = () => readChartTypeSettings(ctx.state());
  const s = () => ctx.series()!;
  return spec.kind === 'pnf' ? [new PnfLayer(s, spec.box, get)] : [new KagiLayer(s, get)];
}

/** Which chart window's template style dialog is open. */
const useCtDialog = create<{ windowId: string | null }>(() => ({ windowId: null }));

function Overlay({ windowId, state }: { windowId: string; state: ChartWindowState }) {
  const open = useCtDialog((d) => d.windowId === windowId);
  const setOpen = (o: boolean) => useCtDialog.setState({ windowId: o ? windowId : null });
  const show = hasTypeSettings(state);
  return (
    <>
      {show && (
        <button
          className="ct-settings-btn"
          data-testid="chart-type-settings"
          title="Template / chart type settings"
          onClick={() => setOpen(true)}
        >
          <SlidersHorizontal size={12} />
          Style
        </button>
      )}
      {state.template === 'cot' && (
        <CotBar
          state={state}
          onChange={(fn) => {
            const cur = useWindows.getState().windows[windowId];
            if (cur?.kind !== 'chart') return;
            const next = readChartTypeSettings(cur);
            fn(next.cot);
            useWindows.getState().patch(windowId, {
              ext: { ...(cur.ext ?? {}), [CT_EXT]: next },
            } as Partial<WindowState>);
          }}
        />
      )}
      {open && (
        <ChartTypeSettingsDialog
          state={state}
          onOpenChange={setOpen}
          onChange={(v) => {
            const cur = useWindows.getState().windows[windowId];
            if (cur?.kind !== 'chart') return;
            useWindows.getState().patch(windowId, {
              ext: { ...(cur.ext ?? {}), [CT_EXT]: v },
            } as Partial<WindowState>);
          }}
        />
      )}
      <TimeframeDialogHost windowId={windowId} s={state} />
      <CustomIntervalDialogHost windowId={windowId} />
      <QuickIntervalHost windowId={windowId} />
    </>
  );
}

registerChartExtension({
  id: CT_EXT,
  layers: chartTypeLayers,
  Overlay,
  menu: (ctx) => [
    {
      id: 'ct-tf',
      label: 'Timeframe dialog…',
      onSelect: () => openTimeframeDialog(ctx.windowId),
    },
  ],
});

const DEFAULT_TF: Partial<Record<string, BarSpec>> = {
  tpo: { kind: 'time', ms: 60_000 },
  cot: { kind: 'time', ms: 3_600_000 },
};

const intervalCommand = (sp: BarSpec) => ({
  id: `chart.timeframe.${specKey(sp)}`,
  label: t('tf.setCmd', { name: specName(sp) }),
  group: 'Chart' as const,
  keywords: 'timeframe interval period bar ticks seconds minutes hours days week month',
  run: () => {
    const id = activeChart();
    if (id) applyTimeframe(id, sp);
  },
});

registerCommands([
  ...INTERVAL_GROUPS.flatMap((g) => g.specs).map(intervalCommand),
  {
    id: 'chart.timeframe-add-custom',
    label: t('tf.addCustomCmd'),
    group: 'Chart',
    keywords: 'timeframe interval custom add',
    run: () => {
      const id = activeChart();
      if (id) openCustomInterval(id);
    },
  },
  {
    id: 'data.cot-refresh',
    label: 'Refresh COT data',
    group: 'Analysis',
    keywords: 'cot cftc commitments of traders download update refresh',
    run: () => {
      const years = Math.max(
        1,
        ...Object.values(useWindows.getState().windows).map((w) =>
          w.kind === 'chart' && w.template === 'cot' ? readChartTypeSettings(w).cot.years : 1,
        ),
      );
      void useCot.getState().refreshAll(years);
    },
  },
  {
    id: 'chart.timeframe-dialog',
    label: 'Chart: Timeframe dialog',
    group: 'Chart',
    run: () => {
      const id = activeChart();
      if (id) openTimeframeDialog(id);
    },
  },
  {
    id: 'chart.timeframe-configure',
    label: 'Chart: Configure timeframe presets',
    group: 'Chart',
    run: () => {
      const id = activeChart();
      if (id) openTimeframeDialog(id, true);
    },
  },
  ...TIMEFRAME_PRESETS.map((r) => ({
    id: `chart.bartype.${r.kind}.${r.row}`,
    label: `Bar type: ${r.row}`,
    group: 'Chart' as const,
    keywords: 'timeframe chart type renko range kagi point figure heikin line break',
    run: () =>
      patchActive((s) => ({
        timeframe: withSession(
          r.specs[0]!,
          (s.timeframe as BarSpec).session,
        ) as ChartWindowState['timeframe'],
      })),
  })),
  ...(['24h', 'eth', 'rth'] as const).map((sess) => ({
    id: `chart.session.${sess}`,
    label: `Session: ${sess.toUpperCase()}`,
    group: 'Chart' as const,
    run: () =>
      patchActive((s) => ({
        timeframe: withSession(s.timeframe as BarSpec, sess) as ChartWindowState['timeframe'],
      })),
  })),
  ...CHART_TEMPLATES.filter((t) => EXTRA_TEMPLATES.includes(t.id)).map((t) => ({
    id: `chart.template.${t.id}`,
    label: `Chart template: ${t.label}`,
    group: 'Chart' as const,
    run: () =>
      patchActive((s) => ({
        template: t.id,
        timeframe: (DEFAULT_TF[t.id] ?? s.timeframe) as ChartWindowState['timeframe'],
      })),
  })),
  {
    id: 'chart.type-settings',
    label: 'Chart: Template style settings',
    group: 'Chart',
    run: () => useCtDialog.setState({ windowId: activeChart() }),
  },
]);

// User-defined intervals are palette commands too (re-registered when the list changes).
let unregisterCustom: (() => void) | null = null;
const registerCustom = (custom: BarSpec[]) => {
  unregisterCustom?.();
  unregisterCustom = registerCommands(custom.map(intervalCommand));
};
useTimeframes.subscribe((st, prev) => {
  if (st.custom !== prev.custom) registerCustom(st.custom);
});
void useTimeframes.getState().load();
