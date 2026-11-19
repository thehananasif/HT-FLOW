import { NumberInput, SegmentedControl } from './components';

import { translateLiteral as tl } from '@htflow/i18n';
export type LineDash = 'solid' | 'dashed' | 'dotted';
export interface LineStyle {
  dash: LineDash;
  width: number;
}

/** Canvas `setLineDash` pattern for a style (scaled by width so dots stay round-ish). */
export function dashPattern(dash: LineDash, width: number): number[] {
  const w = Math.max(1, width);
  if (dash === 'dashed') return [w * 4, w * 3];
  if (dash === 'dotted') return [w, w * 2];
  return [];
}

const DASH_CSS: Record<LineDash, string> = { solid: '0', dashed: '8 5', dotted: '1.5 4' };

function Preview({ dash, width }: LineStyle) {
  return (
    <svg width="44" height="14" viewBox="0 0 44 14" aria-hidden>
      <line
        x1="2"
        y1="7"
        x2="42"
        y2="7"
        stroke="currentColor"
        strokeWidth={width}
        strokeDasharray={DASH_CSS[dash]}
        strokeLinecap={dash === 'dotted' ? 'round' : 'butt'}
      />
    </svg>
  );
}

export interface LineStylePickerProps {
  value: LineStyle;
  onChange: (v: LineStyle) => void;
  maxWidth?: number;
  className?: string;
  'aria-label'?: string;
}

export function LineStylePicker({
  value,
  onChange,
  maxWidth = 8,
  className,
  'aria-label': ariaLabel = 'Line style',
}: LineStylePickerProps) {
  return (
    <div className={`ht-linestyle ${className ?? ''}`} role="group" aria-label={ariaLabel}>
      <SegmentedControl<LineDash>
        aria-label={tl('Dash style')}
        value={value.dash}
        onChange={(dash) => onChange({ ...value, dash })}
        options={(['solid', 'dashed', 'dotted'] as const).map((d) => ({
          value: d,
          title: d,
          label: <Preview dash={d} width={2} />,
        }))}
      />
      <NumberInput
        aria-label={tl('Line width')}
        value={value.width}
        min={1}
        max={maxWidth}
        step={1}
        unit="px"
        onChange={(width) => onChange({ ...value, width })}
      />
      <span className="ht-linestyle-preview" data-testid="line-preview">
        <Preview {...value} />
      </span>
    </div>
  );
}
