import { useEffect, useRef, useState } from 'react';
import { Button, GradientEditor, gradientCss, Select } from '@htflow/ui-kit';
import { GRADIENT_LABELS, GRADIENTS, presetStops } from '@htflow/heatmap';
import type { HeatmapModuleSettings } from './model';
import { NumberRow, Section, SegRow, SliderRow, type Patch } from './controls';

import { translateLiteral as tl } from '@htflow/i18n';
export interface QuickSettingsProps {
  s: HeatmapModuleSettings;
  onPatch: Patch;
  mode3d: boolean;
  onMode3d: (v: boolean) => void;
  savedGradients: Record<string, { pos: number; color: string }[]>;
  onSaveGradient: (name: string) => void;
  onOpenFull: () => void;
  onClose: () => void;
}

/** Stops currently shown (preset or custom). */
export function currentStops(s: HeatmapModuleSettings) {
  return s.gradient === 'custom' ? s.customStops : presetStops(s.gradient);
}

/** Heat map colour: presets, saved gradients and the custom gradient editor. */
export function GradientField({
  s,
  onPatch,
  saved,
  onSave,
}: {
  s: HeatmapModuleSettings;
  onPatch: Patch;
  saved: Record<string, { pos: number; color: string }[]>;
  onSave: (name: string) => void;
}) {
  const [edit, setEdit] = useState(s.gradient === 'custom');
  const options = [
    ...Object.keys(GRADIENTS).map((k) => ({ value: k, label: GRADIENT_LABELS[k] ?? k })),
    ...Object.keys(saved).map((k) => ({ value: `saved:${k}`, label: `★ ${k}` })),
    { value: 'custom', label: 'Custom…' },
  ];
  return (
    <div className="hm-grad">
      <div className="hm-row">
        <span className="hm-row-label">{tl('Heat map colour')}</span>
        <Select
          small
          aria-label={tl('Heat map colour')}
          value={s.gradient}
          options={options}
          onChange={(v) => {
            if (v.startsWith('saved:')) {
              const stops = saved[v.slice(6)];
              if (stops) onPatch({ gradient: 'custom', customStops: stops });
              setEdit(true);
            } else if (v === 'custom') {
              onPatch({ gradient: 'custom', customStops: currentStops(s) });
              setEdit(true);
            } else onPatch({ gradient: v });
          }}
        />
      </div>
      <button
        type="button"
        className="hm-grad-preview"
        aria-label={tl('Edit gradient')}
        aria-expanded={edit}
        style={{ backgroundImage: gradientCss(currentStops(s), 90) }}
        onClick={() => setEdit((x) => !x)}
      />
      {edit && (
        <div className="hm-grad-editor" data-testid="heatmap-gradient-editor">
          <GradientEditor
            label={tl('Custom heat gradient')}
            stops={currentStops(s)}
            onChange={(stops) => onPatch({ gradient: 'custom', customStops: stops })}
          />
          <div className="row gap6">
            <Button
              size="sm"
              onClick={() => {
                const name = window.prompt('Name for this gradient', 'My gradient');
                if (name && name.trim()) onSave(name.trim().slice(0, 40));
              }}
            >
              {tl('Save gradient…')}
            </Button>
            <Button size="sm" onClick={() => onPatch({ gradient: 'thermal' })}>
              {tl('Reset to default')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Quick settings (Settings ▾): exactly the spec sections — Heatmap, Bubbles, Best Bid/Ask,
 * Depth of Market, Volume, 3D Mode — each with a (?) help icon, then "Open full settings".
 */
export function QuickSettings(p: QuickSettingsProps) {
  const { s, onPatch } = p;
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Element;
      if (root.current?.contains(t)) return;
      // Clicks inside portals opened from the popover (tooltips, colour pickers, selects).
      if (t.closest?.('.ht-tooltip, .ht-cp-pop, [data-hm-qs-trigger]')) return;
      p.onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') p.onClose();
    };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key);
    };
  }, [p]);
  return (
    <div
      ref={root}
      className="hm-qs"
      role="dialog"
      aria-label={tl('Heatmap quick settings')}
      data-testid="heatmap-quick-settings"
    >
      <Section
        title={tl('Heatmap')}
        testId="hm-sec-heatmap"
        help={tl(
          'Resting limit-order size as colour: x = time column, y = price, colour = size. Cut-offs clip outliers; normalise per column to read thin periods.',
        )}
        on={s.heat}
        onToggle={(v) => onPatch({ heat: v })}
      >
        <GradientField s={s} onPatch={onPatch} saved={p.savedGradients} onSave={p.onSaveGradient} />
        <SliderRow s={s} k="brightness" label={tl('Brightness')} onPatch={onPatch} />
        <SliderRow
          s={s}
          k="cutoffUpper"
          label={tl('Cut-off upper %')}
          help={tl('Sizes at or above this percentile get the hottest colour (default 98).')}
          onPatch={onPatch}
        />
        <SliderRow
          s={s}
          k="cutoffLower"
          label={tl('Cut-off lower %')}
          help={tl('Sizes at or below this percentile are background (default 20).')}
          onPatch={onPatch}
        />
        <SegRow
          label={tl('Scale')}
          value={s.scale}
          options={[
            { value: 'linear', label: 'Linear' },
            { value: 'log', label: 'Log' },
            { value: 'sqrt', label: 'Sqrt' },
          ]}
          onChange={(v) => onPatch({ scale: v })}
        />
        <SegRow
          label={tl('Normalise')}
          help={tl(
            'Global: one colour range for the whole view. Per column: each time column uses its own range.',
          )}
          value={s.normalize}
          options={[
            { value: 'global', label: 'Global' },
            { value: 'column', label: 'Per column' },
          ]}
          onChange={(v) => onPatch({ normalize: v })}
        />
      </Section>
      <Section
        title={tl('Bubbles')}
        testId="hm-sec-bubbles"
        help={tl(
          'Trades as bubbles: size by volume or delta, merged within N ticks / N × 100 ms, filled as buy/sell pie, dominant side or one colour. Hover for details.',
        )}
        on={s.bubbles}
        onToggle={(v) => onPatch({ bubbles: v })}
      >
        <SliderRow s={s} k="bubbleScale" label={tl('Size')} onPatch={onPatch} />
        <SliderRow
          s={s}
          k="clustering"
          label={tl('Clustering')}
          help={tl('Merge trades within N ticks and N × 100 ms (0 = per price and column).')}
          onPatch={onPatch}
          format={(v) => v.toFixed(1)}
        />
        <SegRow
          label={tl('Calc')}
          value={s.bubbleCalc}
          options={[
            { value: 'volume', label: 'Volume' },
            { value: 'delta', label: 'Delta' },
          ]}
          onChange={(v) => onPatch({ bubbleCalc: v })}
        />
        <SegRow
          label={tl('Fill')}
          help={tl(
            'Pie: buy / sell slices. Dominant: colour of the larger side. Plain: one colour.',
          )}
          value={s.bubbleStyle}
          options={[
            { value: 'pie', label: 'Pie' },
            { value: 'dominant', label: 'Dominant' },
            { value: 'plain', label: 'Plain' },
          ]}
          onChange={(v) => onPatch({ bubbleStyle: v })}
        />
        <NumberRow
          s={s}
          k="minLots"
          label={tl('Min size')}
          help={tl('Bubbles smaller than this (in Calc units) are hidden.')}
          onPatch={onPatch}
        />
      </Section>
      <Section
        title={tl('Best Bid/Ask')}
        testId="hm-sec-bba"
        help={tl(
          'Stepped best bid (green) and best ask (red) lines with a dashed extension into the future.',
        )}
        on={s.bestBidAsk}
        onToggle={(v) => onPatch({ bestBidAsk: v })}
      >
        <SegRow
          label={tl('Lines')}
          value={s.bbaMode}
          options={[
            { value: 'bid-ask', label: 'Bid + Ask' },
            { value: 'mid', label: 'Mid' },
          ]}
          onChange={(v) => onPatch({ bbaMode: v })}
        />
        <SegRow
          label={tl('Extend')}
          value={s.bbaExtend ? 'on' : 'off'}
          options={[
            { value: 'on', label: 'Dashed' },
            { value: 'off', label: 'Off' },
          ]}
          onChange={(v) => onPatch({ bbaExtend: v === 'on' })}
        />
      </Section>
      <Section
        title={tl('Depth of Market')}
        testId="hm-sec-dom"
        help={tl(
          'Right-side histogram of the current book with size labels and the touch highlighted.',
        )}
        on={s.domColumn}
        onToggle={(v) => onPatch({ domColumn: v })}
      >
        <SegRow
          label={tl('Labels')}
          value={s.domLabels ? 'on' : 'off'}
          options={[
            { value: 'on', label: 'Sizes + prices' },
            { value: 'off', label: 'Bars only' },
          ]}
          onChange={(v) => onPatch({ domLabels: v === 'on' })}
        />
      </Section>
      <Section
        title={tl('Volume')}
        testId="hm-sec-volume"
        help={tl('Bottom bars per time column: buy / sell volume stacked, or delta (buy − sell).')}
        on={s.volume}
        onToggle={(v) => onPatch({ volume: v })}
      >
        <SegRow
          label={tl('Calc')}
          value={s.volumeCalc}
          options={[
            { value: 'volume', label: 'Volume' },
            { value: 'delta', label: 'Delta' },
          ]}
          onChange={(v) => onPatch({ volumeCalc: v })}
        />
        <SegRow
          label={tl('Labels')}
          value={s.volumeLabels ? 'on' : 'off'}
          options={[
            { value: 'on', label: 'On' },
            { value: 'off', label: 'Off' },
          ]}
          onChange={(v) => onPatch({ volumeLabels: v === 'on' })}
        />
      </Section>
      <Section
        title={tl('3D Mode')}
        testId="hm-sec-3d"
        help={tl(
          'Time × price × size as an extruded surface in the same colours. Drag to orbit, wheel to zoom, double-click to reset.',
        )}
        on={p.mode3d}
        onToggle={p.onMode3d}
      />
      <Button block onClick={p.onOpenFull} data-testid="heatmap-open-full-settings">
        {tl('Open full settings')}
      </Button>
    </div>
  );
}
