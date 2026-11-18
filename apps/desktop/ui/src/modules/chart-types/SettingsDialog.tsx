import type { ReactNode } from 'react';
import {
  Button,
  Checkbox,
  ColorPicker,
  Dialog,
  Field,
  NumberInput,
  Select,
  SegmentedControl,
} from '@htflow/ui-kit';
import { GRADIENTS } from '@htflow/heatmap';
import { specLabel, type BarSpec } from '@htflow/market-data';
import { CHART_TEMPLATES, type ChartWindowState } from '@htflow/workspace';
import {
  DEFAULT_CHART_TYPE_SETTINGS,
  readChartTypeSettings,
  sanitizeChartTypeSettings,
  type ChartTypeSettings,
} from '../../charts/layers/settings';
import { EXTRA_TEMPLATES } from '../../charts/layers/templates';

/** Templates and chart types that have their own style settings. */
export function hasTypeSettings(s: ChartWindowState): boolean {
  const k = (s.timeframe as BarSpec).kind;
  return EXTRA_TEMPLATES.includes(s.template) || k === 'pnf' || k === 'kagi';
}

const MTF_CHOICES = [60_000, 300_000, 900_000, 1_800_000, 3_600_000, 14_400_000, 86_400_000];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="col gap8" style={{ border: 0, padding: 0, margin: '0 0 12px' }}>
      <legend className="ht-label" style={{ marginBottom: 6 }}>
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

/** Live-preview style settings for the current template / chart type (saved with the window). */
export function ChartTypeSettingsDialog({
  state,
  onOpenChange,
  onChange,
}: {
  state: ChartWindowState;
  onOpenChange: (o: boolean) => void;
  onChange: (v: ChartTypeSettings) => void;
}) {
  const st = readChartTypeSettings(state);
  const set = (fn: (x: ChartTypeSettings) => void) => {
    const next = structuredClone(st);
    fn(next);
    onChange(sanitizeChartTypeSettings(next));
  };
  const kind = (state.timeframe as BarSpec).kind;
  const tpl = CHART_TEMPLATES.find((t) => t.id === state.template)?.label ?? state.template;
  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title={`${tpl} — style`}
      description="Changes apply live and are saved with the window."
      width={460}
    >
      <div className="col gap8" style={{ maxHeight: '64vh', overflowY: 'auto' }}>
        <Section title="Colours (empty = theme)">
          <div className="row gap8 wrap">
            {(['up', 'down', 'highlight', 'text'] as const).map((k) => (
              <ColorPicker
                key={k}
                label={k[0]!.toUpperCase() + k.slice(1)}
                value={st.colors[k] || '#888888'}
                alpha={false}
                onChange={(hex) => set((x) => (x.colors[k] = hex.slice(0, 7)))}
              />
            ))}
          </div>
        </Section>

        {state.template === 'tpo' && (
          <Section title="TPO">
            <Field label="Period (minutes)">
              <NumberInput
                value={st.tpo.periodMin}
                min={1}
                max={240}
                onChange={(v) => set((x) => (x.tpo.periodMin = v))}
              />
            </Field>
            <Field label="Profile split / merge">
              <Select
                value={st.tpo.split}
                onChange={(v) => set((x) => (x.tpo.split = v))}
                options={[
                  { value: '1h', label: 'Split: 1 hour' },
                  { value: '4h', label: 'Split: 4 hours' },
                  { value: 'day', label: 'Day (UTC)' },
                  { value: 'session', label: 'Trading session' },
                  { value: 'week', label: 'Merge: week' },
                ]}
              />
            </Field>
            <Field label="Value area (%)">
              <NumberInput
                value={st.tpo.valueAreaPct}
                min={10}
                max={100}
                onChange={(v) => set((x) => (x.tpo.valueAreaPct = v))}
              />
            </Field>
            <Field label="Initial balance (periods)">
              <NumberInput
                value={st.tpo.ibPeriods}
                min={1}
                max={12}
                onChange={(v) => set((x) => (x.tpo.ibPeriods = v))}
              />
            </Field>
            <Field label="Ticks per row (0 = auto)">
              <NumberInput
                value={st.tpo.rowTicks}
                min={0}
                max={10000}
                onChange={(v) => set((x) => (x.tpo.rowTicks = v))}
              />
            </Field>
            <Field label="Profile width (px)">
              <NumberInput
                value={st.tpo.slotWidth}
                min={60}
                max={1200}
                step={20}
                onChange={(v) => set((x) => (x.tpo.slotWidth = v))}
              />
            </Field>
            <SegmentedControl
              aria-label="TPO display"
              value={st.tpo.display}
              onChange={(v) => set((x) => (x.tpo.display = v))}
              options={[
                { value: 'letters', label: 'Letters' },
                { value: 'blocks', label: 'Blocks' },
              ]}
            />
            <Checkbox
              label="Value area"
              checked={st.tpo.showValueArea}
              onChange={(v) => set((x) => (x.tpo.showValueArea = v))}
            />
            <Checkbox
              label="POC row"
              checked={st.tpo.showPoc}
              onChange={(v) => set((x) => (x.tpo.showPoc = v))}
            />
            <Checkbox
              label="Initial balance"
              checked={st.tpo.showIb}
              onChange={(v) => set((x) => (x.tpo.showIb = v))}
            />
            <Checkbox
              label="Single prints"
              checked={st.tpo.showSingles}
              onChange={(v) => set((x) => (x.tpo.showSingles = v))}
            />
          </Section>
        )}

        {state.template === 'mtf' && (
          <Section title="Multi-timeframe">
            <SegmentedControl
              aria-label="MTF layout"
              value={st.mtf.layout}
              onChange={(v) => set((x) => (x.mtf.layout = v))}
              options={[
                { value: 'overlay', label: 'Boxes behind' },
                { value: 'side', label: 'Side by side' },
                { value: 'stacked', label: 'Stacked' },
              ]}
            />
            <span className="muted">Extra timeframes (1–3, plus the chart's own)</span>
            <div className="row gap8 wrap">
              {MTF_CHOICES.map((ms) => (
                <Checkbox
                  key={ms}
                  label={specLabel({ kind: 'time', ms })}
                  checked={st.mtf.tfs.includes(ms)}
                  onChange={(on) =>
                    set((x) => {
                      const t = on ? [...x.mtf.tfs, ms] : x.mtf.tfs.filter((y) => y !== ms);
                      x.mtf.tfs = (t.length ? t : x.mtf.tfs).sort((a, b) => a - b).slice(0, 3);
                    })
                  }
                />
              ))}
            </div>
            <Field label="Box opacity (%)">
              <NumberInput
                value={st.mtf.opacity}
                min={2}
                max={80}
                onChange={(v) => set((x) => (x.mtf.opacity = v))}
              />
            </Field>
          </Section>
        )}

        {state.template === 'volume-histogram' && (
          <Section title="Volume histogram">
            <SegmentedControl
              aria-label="Colour by"
              value={st.volumeHistogram.colorBy}
              onChange={(v) => set((x) => (x.volumeHistogram.colorBy = v))}
              options={[
                { value: 'delta', label: 'Delta' },
                { value: 'volume', label: 'Volume' },
              ]}
            />
            <Field label="Width (% of bar)">
              <NumberInput
                value={st.volumeHistogram.widthPct}
                min={20}
                max={100}
                onChange={(v) => set((x) => (x.volumeHistogram.widthPct = v))}
              />
            </Field>
            <Checkbox
              label="Values"
              checked={st.volumeHistogram.showValues}
              onChange={(v) => set((x) => (x.volumeHistogram.showValues = v))}
            />
            <Checkbox
              label="Highlight max level"
              checked={st.volumeHistogram.highlightMax}
              onChange={(v) => set((x) => (x.volumeHistogram.highlightMax = v))}
            />
          </Section>
        )}

        {state.template === 'imbalance' && (
          <Section title="Imbalance">
            <Field label="Ratio (%)">
              <NumberInput
                value={st.imbalance.ratio}
                min={101}
                max={2000}
                step={25}
                onChange={(v) => set((x) => (x.imbalance.ratio = v))}
              />
            </Field>
            <Field label="Minimum volume">
              <NumberInput
                value={st.imbalance.minVolume}
                min={0}
                onChange={(v) => set((x) => (x.imbalance.minVolume = v))}
              />
            </Field>
            <Field label="Stacked levels">
              <NumberInput
                value={st.imbalance.stacked}
                min={2}
                max={10}
                onChange={(v) => set((x) => (x.imbalance.stacked = v))}
              />
            </Field>
            <Checkbox
              label="Extend stacked zones until filled"
              checked={st.imbalance.extendZones}
              onChange={(v) => set((x) => (x.imbalance.extendZones = v))}
            />
          </Section>
        )}

        {state.template === 'onchart-liquidity' && (
          <Section title="Liquidity heat">
            <Field label="Gradient">
              <Select
                value={st.liquidity.gradient}
                onChange={(v) => set((x) => (x.liquidity.gradient = v))}
                options={Object.keys(GRADIENTS).map((g) => ({ value: g, label: g }))}
              />
            </Field>
            <Field label="Opacity (%)">
              <NumberInput
                value={st.liquidity.opacity}
                min={5}
                max={100}
                onChange={(v) => set((x) => (x.liquidity.opacity = v))}
              />
            </Field>
            <Field label="Upper cut-off (percentile)">
              <NumberInput
                value={st.liquidity.upperCut}
                min={50}
                max={100}
                onChange={(v) => set((x) => (x.liquidity.upperCut = v))}
              />
            </Field>
          </Section>
        )}

        {state.template === 'order-flow-light' && (
          <Section title="Order Flow (Light)">
            <Field label="Big trade bubbles ≥ (lots)">
              <NumberInput
                value={st.orderFlowLight.bigTrade}
                min={0}
                onChange={(v) => set((x) => (x.orderFlowLight.bigTrade = v))}
              />
            </Field>
            <Checkbox
              label="Bubbles"
              checked={st.orderFlowLight.showBubbles}
              onChange={(v) => set((x) => (x.orderFlowLight.showBubbles = v))}
            />
            <Checkbox
              label="CVD pane"
              checked={st.orderFlowLight.showCvd}
              onChange={(v) => set((x) => (x.orderFlowLight.showCvd = v))}
            />
          </Section>
        )}

        {state.template === 'cot' && (
          <Section title="COT (CFTC Commitments of Traders)">
            <Field label="Weekly history (years)">
              <NumberInput
                value={st.cot.years}
                min={1}
                max={25}
                step={1}
                onChange={(v) => set((x) => (x.cot.years = v))}
              />
            </Field>
            {(
              [
                ['commercial', 'Commercials net'],
                ['noncommercial', 'Non-commercials net'],
                ['producer', 'Producers / merchants net'],
                ['swap', 'Swap dealers net'],
                ['managed', 'Managed money net'],
                ['dealer', 'Dealers / intermediaries net'],
                ['assetmgr', 'Asset managers net'],
                ['levmoney', 'Leveraged funds net'],
                ['other', 'Other reportables net'],
                ['nonreportable', 'Non-reportable net'],
              ] as const
            ).map(([k, label]) => (
              <Checkbox
                key={k}
                label={label}
                checked={!st.cot.hidden.includes(k)}
                onChange={(v) =>
                  set((x) => {
                    x.cot.hidden = v ? x.cot.hidden.filter((h) => h !== k) : [...x.cot.hidden, k];
                  })
                }
              />
            ))}
            <Checkbox
              label="Open interest"
              checked={st.cot.openInterest}
              onChange={(v) => set((x) => (x.cot.openInterest = v))}
            />
          </Section>
        )}

        {kind === 'pnf' && (
          <Section title="Point & Figure">
            <SegmentedControl
              aria-label="P&F style"
              value={st.pnf.style}
              onChange={(v) => set((x) => (x.pnf.style = v))}
              options={[
                { value: 'glyphs', label: 'X / O' },
                { value: 'boxes', label: 'Boxes' },
              ]}
            />
          </Section>
        )}

        {kind === 'kagi' && (
          <Section title="Kagi">
            <Field label="Yang (thick) width">
              <NumberInput
                value={st.kagi.yangWidth}
                min={1}
                max={8}
                onChange={(v) => set((x) => (x.kagi.yangWidth = v))}
              />
            </Field>
            <Field label="Yin (thin) width">
              <NumberInput
                value={st.kagi.yinWidth}
                min={1}
                max={8}
                onChange={(v) => set((x) => (x.kagi.yinWidth = v))}
              />
            </Field>
          </Section>
        )}

        <div className="row gap8">
          <Button variant="ghost" onClick={() => onChange(DEFAULT_CHART_TYPE_SETTINGS)}>
            Reset
          </Button>
          <div className="grow" />
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
