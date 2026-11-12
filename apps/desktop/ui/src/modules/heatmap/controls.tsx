import type { ReactNode } from 'react';
import { HelpCircle } from 'lucide-react';
import { NumberInput, SegmentedControl, Slider, Tooltip } from '@htflow/ui-kit';
import { RANGES, type HeatmapModuleSettings } from './model';

/** (?) icon with a help tooltip. */
export function Help({ text }: { text: string }) {
  return (
    <Tooltip content={<span className="hm-help-text">{text}</span>}>
      <button type="button" className="hm-help" aria-label={`Help: ${text}`}>
        <HelpCircle size={12} />
      </button>
    </Tooltip>
  );
}

export type Patch = (p: Partial<HeatmapModuleSettings>) => void;

type NumKey = {
  [K in keyof HeatmapModuleSettings]: HeatmapModuleSettings[K] extends number ? K : never;
}[keyof HeatmapModuleSettings];

/** Labelled slider + exact value for a numeric setting (range from model.RANGES). */
export function SliderRow({
  s,
  k,
  label,
  help,
  onPatch,
  format,
}: {
  s: HeatmapModuleSettings;
  k: NumKey;
  label: string;
  help?: string;
  onPatch: Patch;
  format?: (v: number) => string;
}) {
  const [min, max, step] = RANGES[k] ?? [0, 100, 1];
  const v = s[k];
  return (
    <div className="hm-row">
      <span className="hm-row-label">
        {label}
        {help && <Help text={help} />}
      </span>
      <Slider
        label={label}
        value={v}
        min={min}
        max={max}
        step={step}
        onChange={(n) => onPatch({ [k]: n } as Partial<HeatmapModuleSettings>)}
      />
      <span className="hm-row-value tnum">{format ? format(v) : v}</span>
    </div>
  );
}

export function NumberRow({
  s,
  k,
  label,
  help,
  unit,
  onPatch,
}: {
  s: HeatmapModuleSettings;
  k: NumKey;
  label: string;
  help?: string;
  unit?: string;
  onPatch: Patch;
}) {
  const [min, max, step] = RANGES[k] ?? [0, 1e9, 1];
  return (
    <div className="hm-row">
      <span className="hm-row-label">
        {label}
        {help && <Help text={help} />}
      </span>
      <NumberInput
        aria-label={label}
        value={s[k]}
        min={min}
        max={max}
        step={step}
        unit={unit}
        onChange={(n) => onPatch({ [k]: n } as Partial<HeatmapModuleSettings>)}
      />
    </div>
  );
}

export function SegRow<T extends string>({
  label,
  help,
  value,
  options,
  onChange,
}: {
  label: string;
  help?: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="hm-row">
      <span className="hm-row-label">
        {label}
        {help && <Help text={help} />}
      </span>
      <SegmentedControl aria-label={label} value={value} options={options} onChange={onChange} />
    </div>
  );
}

/** Section with an on/off checkbox header and a help icon (quick-settings popover). */
export function Section({
  title,
  help,
  on,
  onToggle,
  children,
  testId,
}: {
  title: string;
  help: string;
  on: boolean;
  onToggle: (v: boolean) => void;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <section className="hm-sec" data-on={on || undefined} data-testid={testId}>
      <header className="hm-sec-head">
        <label className="hm-sec-check">
          <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)} />
          <span>{title}</span>
        </label>
        <Help text={help} />
      </header>
      {children && <div className="hm-sec-body">{children}</div>}
    </section>
  );
}
