/**
 * Footprint quick settings (P10): mode, ticks per row, imbalance (diagonal / horizontal, ratio,
 * min volume, stacked levels), auto-collapse width, POC, value area per bar, filters (min volume,
 * min delta), colours of every element and presets (save / load / delete). Every change applies
 * live to the chart; "Open full settings" opens the Footprint tab of Chart settings.
 */
import { useState, useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { FOOTPRINT_MODES } from '@htflow/footprint';
import { Button, Checkbox, ColorSwatch, Dialog, NumberInput, Select, toast } from '@htflow/ui-kit';
import type { ChartWindowState, WindowState } from '@htflow/workspace';
import { Persisted } from '../trading/persist';
import { useWindows } from '../state/windows';
import { useChartSettingsUi } from './settingsUi';
import { chartSettings, setChartSetting, setChartSettings } from './settings/state';
import { sBool, sNum, sStr } from './settings/schema';
import {
  applyPresetValues,
  BUILTIN_PRESETS,
  deletePreset,
  normalizePresets,
  presetFromSettings,
  savePreset,
  type FootprintPreset,
} from './footprintQuick';

/** Which chart the quick dialog is open for. */
export const useFootprintQuick = create<{
  openFor: string | null;
  open(windowId: string): void;
  close(): void;
}>((set) => ({
  openFor: null,
  open: (openFor) => set({ openFor }),
  close: () => set({ openFor: null }),
}));

/** User presets, saved per profile. */
export const footprintPresets = new Persisted<FootprintPreset[]>(
  'footprint.presets',
  () => [],
  normalizePresets,
);

const TPR = ['auto', '1', '2', '4', '5', '10', '20'].map((v) => ({
  value: v,
  label: v === 'auto' ? 'Auto' : v,
}));

/** Loads a preset into a chart window (quick keys + footprint mode). */
export function loadPreset(windowId: string, p: FootprintPreset): void {
  const w = useWindows.getState().windows[windowId];
  if (w?.kind !== 'chart') return;
  setChartSettings(windowId, applyPresetValues(chartSettings(w), p));
  const cur = useWindows.getState().windows[windowId] as ChartWindowState;
  useWindows.getState().patch(windowId, {
    footprintMode: p.mode,
    template: cur.template === 'candles-vp' ? 'footprint' : cur.template,
  } as Partial<WindowState>);
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="row gap8 center-y fpq-row">
      <span className="fpq-label">{label}</span>
      <div className="row gap6 center-y grow">{children}</div>
    </div>
  );
}

export function FootprintQuickSettings() {
  const windowId = useFootprintQuick((s) => s.openFor);
  const close = useFootprintQuick((s) => s.close);
  const w = useWindows((s) => (windowId ? s.windows[windowId] : undefined));
  const user = useSyncExternalStore(footprintPresets.subscribe, () => footprintPresets.get());
  const [presetId, setPresetId] = useState('');
  const [name, setName] = useState('');
  const chart = w?.kind === 'chart' ? w : undefined;
  if (!windowId || !chart) return null;
  const s = chartSettings(chart);
  const set = (k: string, v: unknown) => setChartSetting(windowId, k, v);
  const num = (k: string, label: string, min: number, max: number, step = 1, unit?: string) => (
    <NumberInput
      value={sNum(s, k)}
      onChange={(v) => set(k, v)}
      min={min}
      max={max}
      step={step}
      unit={unit}
      aria-label={label}
    />
  );
  const colour = (k: string, label: string) => (
    <ColorSwatch label={label} value={sStr(s, k) || '#000000'} onChange={(v) => set(k, v)} />
  );
  const all = [...BUILTIN_PRESETS, ...user];
  const selected = all.find((p) => p.id === presetId);
  return (
    <Dialog open onOpenChange={(o) => !o && close()} title="Footprint quick settings" width={460}>
      <div className="fpq" data-testid="fp-quick">
        <div className="fpq-sec">Presets</div>
        <Row label="Preset">
          <Select
            small
            className="grow"
            aria-label="Footprint preset"
            value={presetId}
            onChange={setPresetId}
            options={[
              { value: '', label: '— choose —' },
              ...all.map((p) => ({
                value: p.id,
                label: p.builtin ? `${p.name} (built-in)` : p.name,
              })),
            ]}
          />
          <Button
            size="sm"
            disabled={!selected}
            onClick={() => {
              if (!selected) return;
              loadPreset(windowId, selected);
              toast('success', 'Preset loaded', selected.name);
            }}
          >
            Load
          </Button>
          <Button
            size="sm"
            disabled={!selected || selected.builtin}
            onClick={() => {
              if (!selected || selected.builtin) return;
              footprintPresets.set(deletePreset(footprintPresets.get(), selected.id));
              setPresetId('');
            }}
          >
            Delete
          </Button>
        </Row>
        <Row label="Save as">
          <input
            className="ht-input grow"
            aria-label="Preset name"
            placeholder="Preset name"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
          />
          <Button
            size="sm"
            disabled={!name.trim()}
            onClick={() => {
              const p = presetFromSettings(name, chart.footprintMode, s);
              const next = savePreset(footprintPresets.get(), p);
              footprintPresets.set(next);
              setPresetId(next.find((x) => x.name === p.name)?.id ?? '');
              setName('');
              toast('success', 'Preset saved', p.name);
            }}
          >
            Save
          </Button>
        </Row>

        <div className="fpq-sec">Content</div>
        <Row label="Mode">
          <Select
            small
            className="grow"
            aria-label="Footprint mode"
            value={chart.footprintMode}
            onChange={(m) =>
              useWindows.getState().patch(windowId, {
                footprintMode: m,
                template: chart.template === 'candles-vp' ? 'footprint' : chart.template,
              } as Partial<WindowState>)
            }
            options={FOOTPRINT_MODES.map((m) => ({
              value: m.id,
              label: `${m.group} · ${m.label}`,
            }))}
          />
        </Row>
        <Row label="Ticks per row">
          <Select
            small
            aria-label="Ticks per row"
            value={sStr(s, 'fp.ticksPerRow')}
            onChange={(v) => set('fp.ticksPerRow', v)}
            options={TPR}
          />
          <span className="muted">Auto-collapse below</span>
          {num('other.autoTransformWidth', 'Auto-collapse width', 0, 200, 1, 'px')}
        </Row>
        <Row label="POC">
          <Checkbox
            checked={sBool(s, 'fp.poc')}
            onChange={(v) => set('fp.poc', v)}
            label="Box per bar"
          />
          {colour('fp.pocBorder', 'POC colour')}
        </Row>
        <Row label="Value area">
          <Checkbox
            checked={sBool(s, 'fp.vaShow')}
            onChange={(v) => set('fp.vaShow', v)}
            label="Per bar"
          />
          {num('fp.vaPct', 'Value area percent', 1, 100, 1, '%')}
          {colour('fp.vaColor', 'Value area colour')}
        </Row>

        <div className="fpq-sec">Imbalance</div>
        <Row label="Imbalance">
          <Checkbox
            checked={sBool(s, 'fp.imbalance')}
            onChange={(v) => set('fp.imbalance', v)}
            label="On"
          />
          <Select
            small
            aria-label="Imbalance direction"
            value={sStr(s, 'fp.imbDirection')}
            onChange={(v) => set('fp.imbDirection', v)}
            options={[
              { value: 'diagonal', label: 'Diagonal' },
              { value: 'horizontal', label: 'Horizontal' },
            ]}
          />
        </Row>
        <Row label="Ratio / min vol">
          {num('fp.imbRate', 'Imbalance ratio', 100, 2000, 10, '%')}
          {num('fp.imbVolume', 'Imbalance minimum volume', 0, 1e9)}
        </Row>
        <Row label="Stacked levels">
          {num('fp.imbStacked', 'Stacked imbalance levels', 2, 10)}
          {colour('fp.imbAsk', 'Buy imbalance colour')}
          {colour('fp.imbBid', 'Sell imbalance colour')}
        </Row>

        <div className="fpq-sec">Filters</div>
        <Row label="Min volume">{num('fp.minVolume', 'Minimum cell volume', 0, 1e9)}</Row>
        <Row label="Min |delta|">{num('fp.minDelta', 'Minimum cell delta', 0, 1e9)}</Row>

        <div className="fpq-sec">Colours</div>
        <Row label="Cells">
          {colour('fp.bidColor', 'Bid colour')}
          {colour('fp.askColor', 'Ask colour')}
          {colour('fp.textColor', 'Text colour')}
        </Row>

        <div className="row gap8 fpq-actions">
          <Button
            onClick={() => {
              close();
              useChartSettingsUi.getState().open(windowId, 'footprint');
            }}
          >
            Open full settings…
          </Button>
          <span className="grow" />
          <Button variant="primary" onClick={close} data-testid="fp-quick-close">
            Close
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
