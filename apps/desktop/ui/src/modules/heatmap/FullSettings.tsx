import { useState } from 'react';
import { Button, Checkbox, ColorPicker, Dialog, Select, Tabs } from '@htflow/ui-kit';
import type { ChartPalette } from '@htflow/chart-engine';
import { getSetting, setSetting, useSetting } from '../../state/settings';
import { COLUMN_WIDTHS, columnLabel, type ColumnMs, type HeatmapModuleSettings } from './model';
import { Help, NumberRow, SegRow, SliderRow, type Patch } from './controls';
import { GradientField } from './QuickSettings';

import { translateLiteral as tl } from '@htflow/i18n';
type Tab = 'heatmap' | 'bubbles' | 'lines' | 'volume' | 'orders' | 'axes' | 'render';

const TABS: { value: Tab; label: string }[] = [
  { value: 'heatmap', label: 'Heatmap' },
  { value: 'bubbles', label: 'Bubbles' },
  { value: 'lines', label: 'Bid/Ask & DOM' },
  { value: 'volume', label: 'Volume' },
  { value: 'orders', label: 'Orders' },
  { value: 'axes', label: 'Axes & history' },
  { value: 'render', label: '3D & rendering' },
];

export interface FullSettingsProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  s: HeatmapModuleSettings;
  onPatch: Patch;
  onReset: () => void;
  columnMs: ColumnMs;
  onColumnMs: (ms: ColumnMs) => void;
  palette: ChartPalette;
  savedGradients: Record<string, { pos: number; color: string }[]>;
  onSaveGradient: (name: string) => void;
}

function Toggle({
  label,
  help,
  checked,
  onChange,
}: {
  label: string;
  help?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="hm-row">
      <Checkbox checked={checked} onChange={onChange} label={label} />
      {help && <Help text={help} />}
    </div>
  );
}

type ColorKey =
  | 'buyColor'
  | 'sellColor'
  | 'plainColor'
  | 'bidColor'
  | 'askColor'
  | 'largeOrderColor'
  | 'lifetimeYoung'
  | 'lifetimeOld'
  | 'icebergColor'
  | 'spoofColor';

function ColorRow({
  s,
  k,
  label,
  fallback,
  onPatch,
}: {
  s: HeatmapModuleSettings;
  k: ColorKey;
  label: string;
  /** Theme colour used when the value is '' (only for theme-following keys). */
  fallback?: string;
  onPatch: Patch;
}) {
  const v = s[k] || fallback || '#FFFFFF';
  return (
    <div className="hm-row">
      <span className="hm-row-label">{label}</span>
      <ColorPicker label={label} value={v} alpha={false} onChange={(c) => onPatch({ [k]: c })} />
      {fallback !== undefined && s[k] !== '' && (
        <button type="button" className="hm-link" onClick={() => onPatch({ [k]: '' })}>
          {tl('Theme')}
        </button>
      )}
    </div>
  );
}

/** "Open full settings": every Heatmap option, persisted per window (P11). */
export function FullSettings(p: FullSettingsProps) {
  const [tab, setTab] = useState<Tab>('heatmap');
  const { s, onPatch, palette } = p;
  const fpsMode = useSetting('common.heatmapFpsMode');
  const fpsCap = useSetting('common.heatmapFpsCap');
  const adapter = useSetting('common.heatmapAdapter');
  return (
    <Dialog
      open={p.open}
      onOpenChange={p.onOpenChange}
      title={tl('Heatmap settings')}
      description={tl(
        'Applies to this window and is saved with the workspace. Defaults come from Settings → Heatmap.',
      )}
      width={620}
    >
      <div className="hm-full" data-testid="heatmap-full-settings">
        <Tabs tabs={TABS} value={tab} onChange={setTab} />
        <div className="hm-full-body">
          {tab === 'heatmap' && (
            <>
              <Toggle
                label={tl('Show heat texture')}
                checked={s.heat}
                onChange={(v) => onPatch({ heat: v })}
              />
              <GradientField
                s={s}
                onPatch={onPatch}
                saved={p.savedGradients}
                onSave={p.onSaveGradient}
              />
              <SliderRow s={s} k="brightness" label={tl('Brightness')} onPatch={onPatch} />
              <SliderRow
                s={s}
                k="contrast"
                label={tl('Contrast')}
                help={tl('50 = neutral. Higher stretches the middle of the colour ramp.')}
                onPatch={onPatch}
              />
              <SliderRow
                s={s}
                k="gamma"
                label={tl('Gamma')}
                help={tl('1 = neutral. Below 1 lifts small resting orders, above 1 hides them.')}
                onPatch={onPatch}
                format={(v) => v.toFixed(2)}
              />
              <SliderRow s={s} k="opacity" label={tl('Opacity %')} onPatch={onPatch} />
              <SliderRow s={s} k="cutoffUpper" label={tl('Cut-off upper %')} onPatch={onPatch} />
              <SliderRow s={s} k="cutoffLower" label={tl('Cut-off lower %')} onPatch={onPatch} />
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
                value={s.normalize}
                options={[
                  { value: 'global', label: 'Global' },
                  { value: 'column', label: 'Per column' },
                ]}
                onChange={(v) => onPatch({ normalize: v })}
              />
              <SegRow
                label={tl('Global range from')}
                help={tl(
                  'Where global cut-offs are measured: the visible window or the whole recorded session.',
                )}
                value={s.scope}
                options={[
                  { value: 'visible', label: 'Visible window' },
                  { value: 'session', label: 'Whole session' },
                ]}
                onChange={(v) => onPatch({ scope: v })}
              />
              <NumberRow
                s={s}
                k="minSize"
                label={tl('Minimum resting size')}
                help={tl('Orders smaller than this are not drawn (0 = all).')}
                onPatch={onPatch}
              />
              <NumberRow
                s={s}
                k="levelsLimit"
                label={tl('Levels per side (0 = all)')}
                onPatch={onPatch}
              />
              <Toggle
                label={tl('Smooth between snapshots')}
                checked={s.smoothing}
                onChange={(v) => onPatch({ smoothing: v })}
              />
            </>
          )}
          {tab === 'bubbles' && (
            <>
              <Toggle
                label={tl('Trade bubbles')}
                checked={s.bubbles}
                onChange={(v) => onPatch({ bubbles: v })}
              />
              <SegRow
                label={tl('Style')}
                value={s.bubbleStyle}
                options={[
                  { value: 'pie', label: 'Pie (buy/sell)' },
                  { value: 'dominant', label: 'Dominant side' },
                  { value: 'plain', label: 'Plain' },
                ]}
                onChange={(v) => onPatch({ bubbleStyle: v })}
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
              <SliderRow s={s} k="bubbleScale" label={tl('Size')} onPatch={onPatch} />
              <SliderRow
                s={s}
                k="clustering"
                label={tl('Clustering')}
                onPatch={onPatch}
                format={(v) => v.toFixed(1)}
              />
              <NumberRow s={s} k="minLots" label={tl('Min size')} onPatch={onPatch} />
              <SliderRow s={s} k="bubbleOpacity" label={tl('Fill opacity %')} onPatch={onPatch} />
              <ColorRow
                s={s}
                k="buyColor"
                label={tl('Buy colour')}
                fallback={palette.up}
                onPatch={onPatch}
              />
              <ColorRow
                s={s}
                k="sellColor"
                label={tl('Sell colour')}
                fallback={palette.down}
                onPatch={onPatch}
              />
              <ColorRow s={s} k="plainColor" label={tl('Plain colour')} onPatch={onPatch} />
            </>
          )}
          {tab === 'lines' && (
            <>
              <Toggle
                label={tl('Best bid / ask lines')}
                checked={s.bestBidAsk}
                onChange={(v) => onPatch({ bestBidAsk: v })}
              />
              <SegRow
                label={tl('Lines')}
                value={s.bbaMode}
                options={[
                  { value: 'bid-ask', label: 'Bid + Ask' },
                  { value: 'mid', label: 'Mid' },
                ]}
                onChange={(v) => onPatch({ bbaMode: v })}
              />
              <ColorRow
                s={s}
                k="bidColor"
                label={tl('Bid colour')}
                fallback={palette.up}
                onPatch={onPatch}
              />
              <ColorRow
                s={s}
                k="askColor"
                label={tl('Ask colour')}
                fallback={palette.down}
                onPatch={onPatch}
              />
              <SliderRow s={s} k="bbaWidth" label={tl('Line width')} onPatch={onPatch} />
              <Toggle
                label={tl('Dashed extension into the future')}
                checked={s.bbaExtend}
                onChange={(v) => onPatch({ bbaExtend: v })}
              />
              <hr className="hm-hr" />
              <Toggle
                label={tl('Depth of Market column')}
                checked={s.domColumn}
                onChange={(v) => onPatch({ domColumn: v })}
              />
              <SliderRow s={s} k="domWidth" label={tl('DOM width (px)')} onPatch={onPatch} />
              <Toggle
                label={tl('Size and price labels')}
                checked={s.domLabels}
                onChange={(v) => onPatch({ domLabels: v })}
              />
              <Toggle
                label={tl('Traded volume profile behind the DOM')}
                checked={s.volumeProfile}
                onChange={(v) => onPatch({ volumeProfile: v })}
              />
            </>
          )}
          {tab === 'volume' && (
            <>
              <Toggle
                label={tl('Volume bars')}
                checked={s.volume}
                onChange={(v) => onPatch({ volume: v })}
              />
              <SegRow
                label={tl('Calc')}
                value={s.volumeCalc}
                options={[
                  { value: 'volume', label: 'Volume' },
                  { value: 'delta', label: 'Delta' },
                ]}
                onChange={(v) => onPatch({ volumeCalc: v })}
              />
              <Toggle
                label={tl('Labels')}
                checked={s.volumeLabels}
                onChange={(v) => onPatch({ volumeLabels: v })}
              />
              <SliderRow s={s} k="volumeHeight" label={tl('Pane height (px)')} onPatch={onPatch} />
            </>
          )}
          {tab === 'orders' && (
            <>
              <h4 className="hm-h">{tl('Large orders')}</h4>
              <Toggle
                label={tl('Outline large orders')}
                help={tl(
                  'Resting orders at or above the size below get an outline for as long as they rest.',
                )}
                checked={s.largeOrders}
                onChange={(v) => onPatch({ largeOrders: v })}
              />
              <NumberRow
                s={s}
                k="largeOrderSize"
                label={tl('Outline at ≥ (contracts)')}
                onPatch={onPatch}
              />
              <ColorRow s={s} k="largeOrderColor" label={tl('Outline colour')} onPatch={onPatch} />
              <h4 className="hm-h">{tl('Order lifetime')}</h4>
              <Toggle
                label={tl('Colour by order lifetime')}
                help={tl(
                  'New liquidity is drawn in the young colour and turns into the old colour as it keeps resting; brightness still shows size.',
                )}
                checked={s.lifetime}
                onChange={(v) => onPatch({ lifetime: v })}
              />
              <ColorRow s={s} k="lifetimeYoung" label={tl('Young')} onPatch={onPatch} />
              <ColorRow s={s} k="lifetimeOld" label={tl('Old')} onPatch={onPatch} />
              <NumberRow
                s={s}
                k="lifetimeMaxSec"
                label={tl('Fully old after')}
                unit="s"
                onPatch={onPatch}
              />
              <h4 className="hm-h">{tl('Icebergs')}</h4>
              <Toggle
                label={tl('Iceberg markers')}
                help={tl(
                  'A level that trades more than it ever shows while refilling (traded ≥ ratio × shown).',
                )}
                checked={s.icebergs}
                onChange={(v) => onPatch({ icebergs: v })}
              />
              <NumberRow s={s} k="icebergRatio" label={tl('Traded ÷ shown ≥')} onPatch={onPatch} />
              <ColorRow s={s} k="icebergColor" label={tl('Marker colour')} onPatch={onPatch} />
              <h4 className="hm-h">{tl('Spoofing')}</h4>
              <Toggle
                label={tl('Spoof flashes')}
                help={tl(
                  'Large liquidity away from the touch that appears and is pulled before it trades flashes when pulled.',
                )}
                checked={s.spoofs}
                onChange={(v) => onPatch({ spoofs: v })}
              />
              <NumberRow
                s={s}
                k="spoofMinSize"
                label={tl('Min size (0 = auto, 4 × mean)')}
                onPatch={onPatch}
              />
              <NumberRow
                s={s}
                k="spoofMaxLifeSec"
                label={tl('Pulled within')}
                unit="s"
                onPatch={onPatch}
              />
              <ColorRow s={s} k="spoofColor" label={tl('Flash colour')} onPatch={onPatch} />
            </>
          )}
          {tab === 'axes' && (
            <>
              <div className="hm-row">
                <span className="hm-row-label">
                  {tl('Column width')}
                  <Help text="Time per column. Depth is recorded every 250 ms; wider columns sample every n-th snapshot." />
                </span>
                <Select
                  small
                  aria-label={tl('Column width')}
                  value={String(p.columnMs)}
                  options={COLUMN_WIDTHS.map((ms) => ({
                    value: String(ms),
                    label: columnLabel(ms),
                  }))}
                  onChange={(v) => p.onColumnMs(Number(v) as ColumnMs)}
                />
              </div>
              <NumberRow
                s={s}
                k="historyMinutes"
                label={tl('History length (0 = all recorded)')}
                unit="min"
                onPatch={onPatch}
              />
              <NumberRow
                s={s}
                k="rangeLevels"
                label={tl('Levels above / below the touch (0 = auto)')}
                onPatch={onPatch}
              />
              <Toggle
                label={tl('Crosshair readout of size at level')}
                checked={s.crosshairReadout}
                onChange={(v) => onPatch({ crosshairReadout: v })}
              />
              <hr className="hm-hr" />
              <Toggle
                label={tl('Price axis')}
                checked={s.priceAxis}
                onChange={(v) => onPatch({ priceAxis: v })}
              />
              <SliderRow
                s={s}
                k="priceAxisWidth"
                label={tl('Price axis width')}
                onPatch={onPatch}
              />
              <Toggle
                label={tl('Time axis')}
                checked={s.timeAxis}
                onChange={(v) => onPatch({ timeAxis: v })}
              />
              <Toggle label={tl('Grid')} checked={s.grid} onChange={(v) => onPatch({ grid: v })} />
            </>
          )}
          {tab === 'render' && (
            <>
              <SegRow
                label={tl('3D renderer')}
                help={tl(
                  'three.js (WebGL) surface, or the Canvas 2D isometric fallback for machines without WebGL.',
                )}
                value={s.renderer3d}
                options={[
                  { value: 'webgl', label: 'three.js (WebGL)' },
                  { value: 'canvas', label: 'Canvas 2D' },
                ]}
                onChange={(v) => onPatch({ renderer3d: v })}
              />
              <SliderRow
                s={s}
                k="surfaceHeight"
                label={tl('Surface height')}
                onPatch={onPatch}
                format={(v) => v.toFixed(1)}
              />
              <SliderRow s={s} k="surfaceCols" label={tl('Surface resolution')} onPatch={onPatch} />
              <hr className="hm-hr" />
              <p className="muted hm-note">{tl('Shared by every heatmap (Settings → Common):')}</p>
              <SegRow
                label={tl('FPS cap')}
                value={fpsMode}
                options={[
                  { value: 'auto', label: 'Auto' },
                  { value: 'manual', label: 'Manual' },
                ]}
                onChange={(v) => setSetting('common.heatmapFpsMode', v)}
              />
              <div className="hm-row">
                <span className="hm-row-label">{tl('Manual cap (fps)')}</span>
                <Select
                  small
                  aria-label={tl('Manual FPS cap')}
                  value={String(fpsCap)}
                  options={[15, 30, 60, 120, 240].map((n) => ({
                    value: String(n),
                    label: String(n),
                  }))}
                  onChange={(v) => setSetting('common.heatmapFpsCap', Number(v))}
                />
              </div>
              <div className="hm-row">
                <span className="hm-row-label">{tl('Video adapter (3D)')}</span>
                <Select
                  small
                  aria-label={tl('Video adapter')}
                  value={adapter}
                  options={[
                    { value: 'auto', label: 'Auto' },
                    { value: 'high-performance', label: 'Discrete' },
                    { value: 'low-power', label: 'Integrated' },
                  ]}
                  onChange={(v) => setSetting('common.heatmapAdapter', v)}
                />
              </div>
            </>
          )}
        </div>
        <div className="row gap8 hm-full-foot">
          <Button
            onClick={() => {
              if (window.confirm('Reset this heatmap to the defaults from Settings → Heatmap?'))
                p.onReset();
            }}
          >
            {tl('Reset to defaults')}
          </Button>
          <div className="grow" />
          <Button variant="primary" onClick={() => p.onOpenChange(false)}>
            {tl('Done')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export const heatFpsCap = () =>
  getSetting('common.heatmapFpsMode') === 'manual' ? getSetting('common.heatmapFpsCap') : 0;
