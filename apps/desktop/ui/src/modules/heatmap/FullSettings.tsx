import { useState } from 'react';
import { Button, Checkbox, ColorPicker, Dialog, Select, Tabs } from '@htflow/ui-kit';
import type { ChartPalette } from '@htflow/chart-engine';
import { getSetting, setSetting, useSetting } from '../../state/settings';
import { COLUMN_WIDTHS, columnLabel, type ColumnMs, type HeatmapModuleSettings } from './model';
import { Help, NumberRow, SegRow, SliderRow, type Patch } from './controls';
import { GradientField } from './QuickSettings';

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
          Theme
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
      title="Heatmap settings"
      description="Applies to this window and is saved with the workspace. Defaults come from Settings → Heatmap."
      width={620}
    >
      <div className="hm-full" data-testid="heatmap-full-settings">
        <Tabs tabs={TABS} value={tab} onChange={setTab} />
        <div className="hm-full-body">
          {tab === 'heatmap' && (
            <>
              <Toggle
                label="Show heat texture"
                checked={s.heat}
                onChange={(v) => onPatch({ heat: v })}
              />
              <GradientField
                s={s}
                onPatch={onPatch}
                saved={p.savedGradients}
                onSave={p.onSaveGradient}
              />
              <SliderRow s={s} k="brightness" label="Brightness" onPatch={onPatch} />
              <SliderRow
                s={s}
                k="contrast"
                label="Contrast"
                help="50 = neutral. Higher stretches the middle of the colour ramp."
                onPatch={onPatch}
              />
              <SliderRow
                s={s}
                k="gamma"
                label="Gamma"
                help="1 = neutral. Below 1 lifts small resting orders, above 1 hides them."
                onPatch={onPatch}
                format={(v) => v.toFixed(2)}
              />
              <SliderRow s={s} k="opacity" label="Opacity %" onPatch={onPatch} />
              <SliderRow s={s} k="cutoffUpper" label="Cut-off upper %" onPatch={onPatch} />
              <SliderRow s={s} k="cutoffLower" label="Cut-off lower %" onPatch={onPatch} />
              <SegRow
                label="Scale"
                value={s.scale}
                options={[
                  { value: 'linear', label: 'Linear' },
                  { value: 'log', label: 'Log' },
                  { value: 'sqrt', label: 'Sqrt' },
                ]}
                onChange={(v) => onPatch({ scale: v })}
              />
              <SegRow
                label="Normalise"
                value={s.normalize}
                options={[
                  { value: 'global', label: 'Global' },
                  { value: 'column', label: 'Per column' },
                ]}
                onChange={(v) => onPatch({ normalize: v })}
              />
              <SegRow
                label="Global range from"
                help="Where global cut-offs are measured: the visible window or the whole recorded session."
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
                label="Minimum resting size"
                help="Orders smaller than this are not drawn (0 = all)."
                onPatch={onPatch}
              />
              <NumberRow
                s={s}
                k="levelsLimit"
                label="Levels per side (0 = all)"
                onPatch={onPatch}
              />
              <Toggle
                label="Smooth between snapshots"
                checked={s.smoothing}
                onChange={(v) => onPatch({ smoothing: v })}
              />
            </>
          )}
          {tab === 'bubbles' && (
            <>
              <Toggle
                label="Trade bubbles"
                checked={s.bubbles}
                onChange={(v) => onPatch({ bubbles: v })}
              />
              <SegRow
                label="Style"
                value={s.bubbleStyle}
                options={[
                  { value: 'pie', label: 'Pie (buy/sell)' },
                  { value: 'dominant', label: 'Dominant side' },
                  { value: 'plain', label: 'Plain' },
                ]}
                onChange={(v) => onPatch({ bubbleStyle: v })}
              />
              <SegRow
                label="Calc"
                value={s.bubbleCalc}
                options={[
                  { value: 'volume', label: 'Volume' },
                  { value: 'delta', label: 'Delta' },
                ]}
                onChange={(v) => onPatch({ bubbleCalc: v })}
              />
              <SliderRow s={s} k="bubbleScale" label="Size" onPatch={onPatch} />
              <SliderRow
                s={s}
                k="clustering"
                label="Clustering"
                onPatch={onPatch}
                format={(v) => v.toFixed(1)}
              />
              <NumberRow s={s} k="minLots" label="Min size" onPatch={onPatch} />
              <SliderRow s={s} k="bubbleOpacity" label="Fill opacity %" onPatch={onPatch} />
              <ColorRow
                s={s}
                k="buyColor"
                label="Buy colour"
                fallback={palette.up}
                onPatch={onPatch}
              />
              <ColorRow
                s={s}
                k="sellColor"
                label="Sell colour"
                fallback={palette.down}
                onPatch={onPatch}
              />
              <ColorRow s={s} k="plainColor" label="Plain colour" onPatch={onPatch} />
            </>
          )}
          {tab === 'lines' && (
            <>
              <Toggle
                label="Best bid / ask lines"
                checked={s.bestBidAsk}
                onChange={(v) => onPatch({ bestBidAsk: v })}
              />
              <SegRow
                label="Lines"
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
                label="Bid colour"
                fallback={palette.up}
                onPatch={onPatch}
              />
              <ColorRow
                s={s}
                k="askColor"
                label="Ask colour"
                fallback={palette.down}
                onPatch={onPatch}
              />
              <SliderRow s={s} k="bbaWidth" label="Line width" onPatch={onPatch} />
              <Toggle
                label="Dashed extension into the future"
                checked={s.bbaExtend}
                onChange={(v) => onPatch({ bbaExtend: v })}
              />
              <hr className="hm-hr" />
              <Toggle
                label="Depth of Market column"
                checked={s.domColumn}
                onChange={(v) => onPatch({ domColumn: v })}
              />
              <SliderRow s={s} k="domWidth" label="DOM width (px)" onPatch={onPatch} />
              <Toggle
                label="Size and price labels"
                checked={s.domLabels}
                onChange={(v) => onPatch({ domLabels: v })}
              />
              <Toggle
                label="Traded volume profile behind the DOM"
                checked={s.volumeProfile}
                onChange={(v) => onPatch({ volumeProfile: v })}
              />
            </>
          )}
          {tab === 'volume' && (
            <>
              <Toggle
                label="Volume bars"
                checked={s.volume}
                onChange={(v) => onPatch({ volume: v })}
              />
              <SegRow
                label="Calc"
                value={s.volumeCalc}
                options={[
                  { value: 'volume', label: 'Volume' },
                  { value: 'delta', label: 'Delta' },
                ]}
                onChange={(v) => onPatch({ volumeCalc: v })}
              />
              <Toggle
                label="Labels"
                checked={s.volumeLabels}
                onChange={(v) => onPatch({ volumeLabels: v })}
              />
              <SliderRow s={s} k="volumeHeight" label="Pane height (px)" onPatch={onPatch} />
            </>
          )}
          {tab === 'orders' && (
            <>
              <h4 className="hm-h">Large orders</h4>
              <Toggle
                label="Outline large orders"
                help="Resting orders at or above the size below get an outline for as long as they rest."
                checked={s.largeOrders}
                onChange={(v) => onPatch({ largeOrders: v })}
              />
              <NumberRow
                s={s}
                k="largeOrderSize"
                label="Outline at ≥ (contracts)"
                onPatch={onPatch}
              />
              <ColorRow s={s} k="largeOrderColor" label="Outline colour" onPatch={onPatch} />
              <h4 className="hm-h">Order lifetime</h4>
              <Toggle
                label="Colour by order lifetime"
                help="New liquidity is drawn in the young colour and turns into the old colour as it keeps resting; brightness still shows size."
                checked={s.lifetime}
                onChange={(v) => onPatch({ lifetime: v })}
              />
              <ColorRow s={s} k="lifetimeYoung" label="Young" onPatch={onPatch} />
              <ColorRow s={s} k="lifetimeOld" label="Old" onPatch={onPatch} />
              <NumberRow
                s={s}
                k="lifetimeMaxSec"
                label="Fully old after"
                unit="s"
                onPatch={onPatch}
              />
              <h4 className="hm-h">Icebergs</h4>
              <Toggle
                label="Iceberg markers"
                help="A level that trades more than it ever shows while refilling (traded ≥ ratio × shown)."
                checked={s.icebergs}
                onChange={(v) => onPatch({ icebergs: v })}
              />
              <NumberRow s={s} k="icebergRatio" label="Traded ÷ shown ≥" onPatch={onPatch} />
              <ColorRow s={s} k="icebergColor" label="Marker colour" onPatch={onPatch} />
              <h4 className="hm-h">Spoofing</h4>
              <Toggle
                label="Spoof flashes"
                help="Large liquidity away from the touch that appears and is pulled before it trades flashes when pulled."
                checked={s.spoofs}
                onChange={(v) => onPatch({ spoofs: v })}
              />
              <NumberRow
                s={s}
                k="spoofMinSize"
                label="Min size (0 = auto, 4 × mean)"
                onPatch={onPatch}
              />
              <NumberRow
                s={s}
                k="spoofMaxLifeSec"
                label="Pulled within"
                unit="s"
                onPatch={onPatch}
              />
              <ColorRow s={s} k="spoofColor" label="Flash colour" onPatch={onPatch} />
            </>
          )}
          {tab === 'axes' && (
            <>
              <div className="hm-row">
                <span className="hm-row-label">
                  Column width
                  <Help text="Time per column. Depth is recorded every 250 ms; wider columns sample every n-th snapshot." />
                </span>
                <Select
                  small
                  aria-label="Column width"
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
                label="History length (0 = all recorded)"
                unit="min"
                onPatch={onPatch}
              />
              <NumberRow
                s={s}
                k="rangeLevels"
                label="Levels above / below the touch (0 = auto)"
                onPatch={onPatch}
              />
              <Toggle
                label="Crosshair readout of size at level"
                checked={s.crosshairReadout}
                onChange={(v) => onPatch({ crosshairReadout: v })}
              />
              <hr className="hm-hr" />
              <Toggle
                label="Price axis"
                checked={s.priceAxis}
                onChange={(v) => onPatch({ priceAxis: v })}
              />
              <SliderRow s={s} k="priceAxisWidth" label="Price axis width" onPatch={onPatch} />
              <Toggle
                label="Time axis"
                checked={s.timeAxis}
                onChange={(v) => onPatch({ timeAxis: v })}
              />
              <Toggle label="Grid" checked={s.grid} onChange={(v) => onPatch({ grid: v })} />
            </>
          )}
          {tab === 'render' && (
            <>
              <SegRow
                label="3D renderer"
                help="three.js (WebGL) surface, or the Canvas 2D isometric fallback for machines without WebGL."
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
                label="Surface height"
                onPatch={onPatch}
                format={(v) => v.toFixed(1)}
              />
              <SliderRow s={s} k="surfaceCols" label="Surface resolution" onPatch={onPatch} />
              <hr className="hm-hr" />
              <p className="muted hm-note">Shared by every heatmap (Settings → Common):</p>
              <SegRow
                label="FPS cap"
                value={fpsMode}
                options={[
                  { value: 'auto', label: 'Auto' },
                  { value: 'manual', label: 'Manual' },
                ]}
                onChange={(v) => setSetting('common.heatmapFpsMode', v)}
              />
              <div className="hm-row">
                <span className="hm-row-label">Manual cap (fps)</span>
                <Select
                  small
                  aria-label="Manual FPS cap"
                  value={String(fpsCap)}
                  options={[15, 30, 60, 120, 240].map((n) => ({
                    value: String(n),
                    label: String(n),
                  }))}
                  onChange={(v) => setSetting('common.heatmapFpsCap', Number(v))}
                />
              </div>
              <div className="hm-row">
                <span className="hm-row-label">Video adapter (3D)</span>
                <Select
                  small
                  aria-label="Video adapter"
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
            Reset to defaults
          </Button>
          <div className="grow" />
          <Button variant="primary" onClick={() => p.onOpenChange(false)}>
            Done
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export const heatFpsCap = () =>
  getSetting('common.heatmapFpsMode') === 'manual' ? getSetting('common.heatmapFpsCap') : 0;
