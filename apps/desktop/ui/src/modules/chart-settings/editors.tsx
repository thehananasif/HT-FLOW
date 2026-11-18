/** Property-grid editors of the Chart settings window (P34). */
import { RotateCcw, Trash2, Plus } from 'lucide-react';
import {
  ColorPicker,
  Combobox,
  GradientEditor,
  Input,
  LineStylePicker,
  NumberInput,
  Select,
  Slider,
  Toggle,
  theme,
  type LineDash,
} from '@htflow/ui-kit';
import {
  TIME_ZONES,
  type FilterRule,
  type LineDashName,
  type LineValue,
  type RowDef,
} from '../../charts/settings/schema';

import { translateLiteral as tl } from '@htflow/i18n';
/** Effective theme colour shown for an empty ("Theme") colour value. */
function themeFallback(key: string): string {
  const t = theme();
  const k = key.toLowerCase();
  const pick =
    k.includes('background') || k.endsWith('.bg')
      ? t.chartBg
      : k.includes('down') || k.includes('bid') || k.includes('sell') || k.includes('neg')
        ? t.down
        : k.includes('up') || k.includes('ask') || k.includes('buy') || k.includes('pos')
          ? t.up
          : k.startsWith('grid')
            ? t.grid
            : k.startsWith('crosshair')
              ? t.textTertiary
              : k.includes('main')
                ? t.cluster
                : t.textSecondary;
  return pick.slice(0, 7).toUpperCase();
}

const toDash = (s: LineDashName): LineDash =>
  s === 'dash' ? 'dashed' : s === 'dot' ? 'dotted' : 'solid';
const fromDash = (d: LineDash): LineDashName =>
  d === 'dashed' ? 'dash' : d === 'dotted' ? 'dot' : 'solid';

/** Colour with "Theme" fallback: empty value follows the app theme. */
function ColorEditor({
  label,
  value,
  fallback,
  onChange,
}: {
  label: string;
  value: string;
  fallback: string;
  onChange(v: string): void;
}) {
  return (
    <span className="cs-color">
      <ColorPicker
        label={label}
        value={value || fallback}
        onChange={(v) => onChange(v.toUpperCase())}
      />
      {value ? (
        <button
          className="ht-icon-btn"
          aria-label={`${label}: use theme colour`}
          title={tl('Use theme colour')}
          onClick={() => onChange('')}
        >
          <RotateCcw size={11} />
        </button>
      ) : (
        <span className="cs-theme-tag">{tl('Theme')}</span>
      )}
    </span>
  );
}

export function RowEditor({
  row,
  value,
  onChange,
}: {
  row: RowDef;
  value: unknown;
  onChange(v: unknown): void;
}) {
  const label = row.label;
  switch (row.type) {
    case 'color':
      return (
        <ColorEditor
          label={label}
          value={String(value ?? '')}
          fallback={themeFallback(row.key)}
          onChange={onChange}
        />
      );
    case 'bool':
      return (
        <span className="cs-bool">
          <Toggle label={label} checked={value === true} onChange={onChange} />
        </span>
      );
    case 'number':
      return (
        <NumberInput
          aria-label={label}
          value={Number(value)}
          min={row.min}
          max={row.max}
          step={row.step ?? 1}
          onChange={onChange}
        />
      );
    case 'slider':
      return (
        <span className="cs-slider">
          <Slider
            label={label}
            value={Number(value)}
            min={row.min}
            max={row.max}
            step={row.step}
            onChange={onChange}
          />
          <span className="tnum">{String(value)}</span>
        </span>
      );
    case 'enum':
      if (row.options === TIME_ZONES)
        return (
          <Combobox
            aria-label={label}
            value={String(value)}
            options={row.options}
            onChange={(v) => onChange(v)}
          />
        );
      return (
        <Select
          small
          aria-label={label}
          value={String(value)}
          options={row.options ?? []}
          onChange={onChange}
        />
      );
    case 'text':
      return (
        <Input
          aria-label={label}
          value={String(value ?? '')}
          maxLength={80}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'time':
      return (
        <Input
          type="time"
          step={1}
          aria-label={label}
          value={String(value ?? '')}
          onChange={(e) => {
            const v = e.target.value.length === 5 ? `${e.target.value}:00` : e.target.value;
            onChange(v);
          }}
        />
      );
    case 'line': {
      const l = value as LineValue;
      return (
        <span className="cs-line">
          <ColorEditor
            label={`${label} colour`}
            value={l.color}
            fallback={themeFallback(row.key)}
            onChange={(color) => onChange({ ...l, color })}
          />
          <LineStylePicker
            aria-label={`${label} style`}
            value={{ dash: toDash(l.style), width: l.width }}
            maxWidth={6}
            onChange={(v) => onChange({ ...l, style: fromDash(v.dash), width: v.width })}
          />
        </span>
      );
    }
    case 'gradient': {
      const cols = String(value ?? '')
        .split(',')
        .filter(Boolean);
      if (!cols.length)
        return (
          <button className="ht-chip" onClick={() => onChange('#1A1A1A,#000000')}>
            {tl('Use a gradient')}
          </button>
        );
      return (
        <span className="cs-grad">
          <GradientEditor
            label={label}
            stops={cols.map((color, i) => ({
              color,
              pos: cols.length > 1 ? i / (cols.length - 1) : 0,
            }))}
            onChange={(stops) =>
              onChange(
                [...stops]
                  .sort((a, b) => a.pos - b.pos)
                  .map((s) => s.color.slice(0, 7).toUpperCase())
                  .join(','),
              )
            }
          />
          <button
            className="ht-icon-btn"
            aria-label={`Clear ${label}`}
            onClick={() => onChange('')}
          >
            <Trash2 size={11} />
          </button>
        </span>
      );
    }
    case 'rules': {
      const rules = (value as FilterRule[]) ?? [];
      const upd = (i: number, p: Partial<FilterRule>) =>
        onChange(rules.map((r, j) => (j === i ? { ...r, ...p } : r)));
      return (
        <div className="cs-rules">
          {rules.map((r, i) => (
            <div key={i} className="cs-rule">
              <Select
                small
                aria-label={tl('Field')}
                value={r.field}
                options={(['volume', 'delta', 'trades', 'bid', 'ask'] as const).map((v) => ({
                  value: v,
                  label: v[0]!.toUpperCase() + v.slice(1),
                }))}
                onChange={(field) => upd(i, { field })}
              />
              <Select
                small
                aria-label={tl('Condition')}
                value={r.op}
                options={[
                  { value: '>=', label: '≥' },
                  { value: '<=', label: '≤' },
                ]}
                onChange={(op) => upd(i, { op })}
              />
              <NumberInput
                aria-label={tl('Value')}
                value={r.value}
                onChange={(v) => upd(i, { value: v })}
              />
              <ColorPicker
                label={tl('Highlight colour')}
                value={r.color}
                onChange={(c) => upd(i, { color: c.slice(0, 7).toUpperCase() })}
              />
              <button
                className="ht-icon-btn"
                aria-label={tl('Remove rule')}
                onClick={() => onChange(rules.filter((_, j) => j !== i))}
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
          <button
            className="ht-chip"
            onClick={() =>
              onChange([...rules, { field: 'volume', op: '>=', value: 100, color: '#E8B04B' }])
            }
          >
            <Plus size={11} /> {tl('Add filter')}
          </button>
        </div>
      );
    }
  }
}

/** Short text of a value for search results / export previews. */
export function valueText(row: RowDef, v: unknown): string {
  if (row.type === 'bool') return v ? 'On' : 'Off';
  if (row.type === 'enum') return row.options?.find((o) => o.value === v)?.label ?? String(v);
  if (row.type === 'line') {
    const l = v as LineValue;
    return `${l.width}px ${l.style} ${l.color || 'theme'}`;
  }
  if (row.type === 'rules') return `Count: ${(v as unknown[]).length}`;
  return String(v ?? '') || 'Theme';
}
