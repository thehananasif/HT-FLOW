import type { InputDef, InputDefs, RawInputs } from '@htflow/indicator-sdk';
import { resolveInputs, SOURCES, TIMEFRAMES } from '@htflow/indicator-sdk';
import type { BarSpec, Instrument } from '@htflow/market-data';
import type { StrategyInstrument } from '@htflow/strategy';
import { Checkbox, ColorSwatch, Input, NumberInput, Select } from '@htflow/ui-kit';

import { translateLiteral as tl } from '@htflow/i18n';
export const openModule = (id: string) =>
  window.dispatchEvent(new CustomEvent('htflow:open-module', { detail: id }));

export const money = (v: number, digits = 0) =>
  (v < 0 ? '−$' : '$') +
  Math.abs(v).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
export const signedMoney = (v: number, digits = 0) => (v > 0 ? '+' : '') + money(v, digits);
export const tone = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
export const ratio = (v: number, d = 2) =>
  Number.isNaN(v) ? '—' : Number.isFinite(v) ? v.toFixed(d) : '∞';
export const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;

export function toStrategyInstrument(i: Instrument): StrategyInstrument {
  return {
    id: i.id,
    symbol: i.symbol,
    tickSize: i.tickSize,
    tickValue: i.tickValue,
    pricePrecision: i.pricePrecision,
  };
}

export const BAR_SPECS: { value: string; label: string; spec: BarSpec }[] = [
  { value: 't60000', label: '1 minute', spec: { kind: 'time', ms: 60_000 } },
  { value: 't300000', label: '5 minutes', spec: { kind: 'time', ms: 300_000 } },
  { value: 't900000', label: '15 minutes', spec: { kind: 'time', ms: 900_000 } },
  { value: 't1800000', label: '30 minutes', spec: { kind: 'time', ms: 1_800_000 } },
  { value: 't3600000', label: '1 hour', spec: { kind: 'time', ms: 3_600_000 } },
  { value: 'k500', label: '500 ticks', spec: { kind: 'tick', n: 500 } },
  { value: 'v1000', label: '1000 volume', spec: { kind: 'volume', n: 1000 } },
  { value: 'r8', label: 'Range 8', spec: { kind: 'range', ticks: 8 } },
];

export function specValue(spec: BarSpec): string {
  switch (spec.kind) {
    case 'time':
      return `t${spec.ms}`;
    case 'tick':
      return `k${spec.n}`;
    case 'volume':
      return `v${spec.n}`;
    case 'delta':
      return `d${spec.n}`;
    case 'range':
      return `r${spec.ticks}`;
    default:
      // Other bar kinds (Renko, range variants, reversal, …) are not offered in the backtest
      // picker; keep a stable key so a saved selection still round-trips.
      return `x:${JSON.stringify(spec)}`;
  }
}

export function specOf(value: string): BarSpec {
  return BAR_SPECS.find((b) => b.value === value)?.spec ?? { kind: 'time', ms: 300_000 };
}

function InputControl({
  id,
  def,
  value,
  onChange,
}: {
  id: string;
  def: InputDef;
  value: unknown;
  onChange: (v: number | boolean | string) => void;
}) {
  switch (def.type) {
    case 'int':
    case 'float':
      return (
        <NumberInput
          aria-label={tl(def.label)}
          value={Number(value)}
          step={def.step}
          min={def.min}
          max={def.max}
          unit={def.unit}
          onChange={onChange}
        />
      );
    case 'bool':
      return <Checkbox checked={!!value} onChange={onChange} label="" />;
    case 'enum':
      return (
        <Select
          small
          aria-label={tl(def.label)}
          value={String(value)}
          options={def.options.map((o) => ({ value: o.value, label: o.label }))}
          onChange={onChange}
        />
      );
    case 'color':
      return <ColorSwatch label={tl(def.label)} value={String(value)} onChange={onChange} />;
    case 'source':
      return (
        <Select
          small
          aria-label={tl(def.label)}
          value={String(value)}
          options={SOURCES.map((s) => ({ value: s.value, label: s.label }))}
          onChange={onChange}
        />
      );
    case 'timeframe':
      return (
        <Select
          small
          aria-label={tl(def.label)}
          value={String(value)}
          options={TIMEFRAMES.map((s) => ({ value: s.value, label: s.label }))}
          onChange={onChange}
        />
      );
    case 'linestyle':
      return (
        <Select
          small
          aria-label={tl(def.label)}
          value={String(value)}
          options={['solid', 'dashed', 'dotted'].map((s) => ({ value: s, label: s }))}
          onChange={onChange}
        />
      );
    default:
      return (
        <Input
          aria-label={tl(def.label)}
          data-input={id}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

/** Form for a strategy's typed inputs: every value is validated through the definition. */
export function InputsForm({
  defs,
  values,
  onChange,
  testId,
}: {
  defs: InputDefs;
  values: RawInputs | undefined;
  onChange: (v: RawInputs) => void;
  testId?: string;
}) {
  const resolved = resolveInputs(defs, values) as RawInputs;
  return (
    <div className="stg-inputs" data-testid={testId}>
      {Object.entries(defs).map(([k, d]) => (
        <label key={k} className="stg-input-row" title={tl(d.help)}>
          <span>{tl(d.label)}</span>
          <InputControl
            id={k}
            def={d}
            value={resolved[k]}
            onChange={(v) => onChange(resolveInputs(defs, { ...resolved, [k]: v }) as RawInputs)}
          />
        </label>
      ))}
    </div>
  );
}

/** Reads a CSS custom property (theme token) with a fallback. */
export function cssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;
export const validColor = (v: unknown, def: string): string =>
  typeof v === 'string' && HEX.test(v) ? v : def;
