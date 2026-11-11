import { useMemo } from 'react';
import { Combobox, type ComboOption } from './Combobox';

export interface FontEntry {
  family: string;
  /** CSS font-family stack used for the preview. */
  stack: string;
  group: 'Bundled' | 'System';
}

/** Fonts shipped with the app (see styles.css @font-face). */
export const BUNDLED_FONTS: FontEntry[] = [
  { family: 'Geist', stack: "'Geist', 'Segoe UI', system-ui, sans-serif", group: 'Bundled' },
  { family: 'Geist Mono', stack: "'Geist Mono', Consolas, monospace", group: 'Bundled' },
];

/** Common Windows/macOS system families offered by default (no permission API needed). */
export const SYSTEM_FONTS: FontEntry[] = [
  'Segoe UI',
  'Arial',
  'Calibri',
  'Consolas',
  'Courier New',
  'Georgia',
  'Helvetica',
  'Lucida Console',
  'Tahoma',
  'Times New Roman',
  'Trebuchet MS',
  'Verdana',
  'system-ui',
  'monospace',
  'sans-serif',
  'serif',
].map((family) => ({ family, stack: family.includes(' ') ? `'${family}'` : family, group: 'System' as const }));

export interface FontPickerProps {
  value: string;
  onChange: (family: string) => void;
  /** Extra families (e.g. from `queryLocalFonts`). */
  extra?: string[];
  previewText?: string;
  className?: string;
  'aria-label'?: string;
}

/** System + bundled Geist fonts, each option rendered in its own face, with a live preview line. */
export function FontPicker({
  value,
  onChange,
  extra = [],
  previewText = 'ES 4,050.25  Buy 12 @ 4,051.00',
  className,
  'aria-label': ariaLabel = 'Font',
}: FontPickerProps) {
  const fonts = useMemo(() => {
    const seen = new Set([...BUNDLED_FONTS, ...SYSTEM_FONTS].map((f) => f.family));
    const more: FontEntry[] = extra
      .filter((f) => !seen.has(f))
      .map((family) => ({ family, stack: `'${family}'`, group: 'System' }));
    return [...BUNDLED_FONTS, ...SYSTEM_FONTS, ...more];
  }, [extra]);
  const options: ComboOption[] = fonts.map((f) => ({
    value: f.family,
    label: f.family,
    hint: <span style={{ fontFamily: f.stack }}>Aa 123</span>,
  }));
  const current = fonts.find((f) => f.family === value);
  return (
    <div className={className}>
      <Combobox value={value} onChange={(v) => onChange(v)} options={options} aria-label={ariaLabel} allowCustom />
      <div
        className="ht-font-preview"
        data-testid="font-preview"
        style={{ fontFamily: current?.stack ?? `'${value}'` }}
      >
        {previewText}
      </div>
    </div>
  );
}
