import {
  SOURCES,
  TIMEFRAMES,
  type BoolInput,
  type ColorInput,
  type EnumInput,
  type FloatInput,
  type InputDef,
  type InputDefs,
  type InputValue,
  type InputValues,
  type IntInput,
  type LineStyle,
  type LineStyleInput,
  type OutputDef,
  type OutputKind,
  type RawInputs,
  type SourceId,
  type SourceInput,
  type StringInput,
  type TimeframeId,
  type TimeframeInput,
} from './types';

interface NumOpts {
  min?: number;
  max?: number;
  step?: number;
  help?: string;
  unit?: string;
  group?: string;
}
interface Opts {
  help?: string;
  group?: string;
}

/** Typed input builders: every input has a default, validation range and help text. */
export const input = {
  int(label: string, def: number, o: NumOpts = {}): IntInput {
    return {
      type: 'int',
      label,
      default: def,
      min: o.min ?? 1,
      max: o.max ?? 5000,
      step: o.step ?? 1,
      help: o.help,
      unit: o.unit,
      group: o.group,
    };
  },
  float(label: string, def: number, o: NumOpts = {}): FloatInput {
    return {
      type: 'float',
      label,
      default: def,
      min: o.min ?? 0,
      max: o.max ?? 1e9,
      step: o.step ?? 0.1,
      help: o.help,
      unit: o.unit,
      group: o.group,
    };
  },
  bool(label: string, def: boolean, o: Opts = {}): BoolInput {
    return { type: 'bool', label, default: def, ...o };
  },
  enum<const T extends string>(
    label: string,
    def: NoInfer<T>,
    options: readonly (readonly [T, string])[],
    o: Opts = {},
  ): EnumInput<T> {
    return {
      type: 'enum',
      label,
      default: def,
      options: options.map(([value, l]) => ({ value, label: l })),
      ...o,
    };
  },
  color(label: string, def: string, o: Opts = {}): ColorInput {
    return { type: 'color', label, default: def, ...o };
  },
  lineStyle(label: string, def: LineStyle, o: Opts = {}): LineStyleInput {
    return { type: 'linestyle', label, default: def, ...o };
  },
  source(
    label: string,
    def: SourceId,
    o: Opts & { sources?: readonly SourceId[] } = {},
  ): SourceInput {
    return { type: 'source', label, default: def, ...o };
  },
  string(label: string, def: string, o: Opts & { maxLength?: number } = {}): StringInput {
    return {
      type: 'string',
      label,
      default: def,
      maxLength: o.maxLength ?? 64,
      help: o.help,
      group: o.group,
    };
  },
  timeframe(
    label: string,
    def: TimeframeId,
    o: Opts & { options?: readonly TimeframeId[] } = {},
  ): TimeframeInput {
    return { type: 'timeframe', label, default: def, ...o };
  },
};

const COLOR_RE = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;

export function isColor(v: unknown): v is string {
  return typeof v === 'string' && COLOR_RE.test(v);
}

/** Validates one raw value against its definition; invalid values fall back to the default. */
export function validateInput(def: InputDef, raw: unknown): InputValue {
  switch (def.type) {
    case 'int':
    case 'float': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
      if (!Number.isFinite(n)) return def.default;
      const c = Math.min(def.max, Math.max(def.min, n));
      return def.type === 'int' ? Math.round(c) : c;
    }
    case 'bool':
      return typeof raw === 'boolean' ? raw : def.default;
    case 'enum':
      return typeof raw === 'string' && def.options.some((o) => o.value === raw)
        ? raw
        : def.default;
    case 'color':
      return isColor(raw) ? raw : def.default;
    case 'linestyle':
      return raw === 'solid' || raw === 'dashed' || raw === 'dotted' ? raw : def.default;
    case 'source': {
      const allowed = def.sources ?? SOURCES.map((s) => s.value);
      return typeof raw === 'string' && (allowed as readonly string[]).includes(raw)
        ? raw
        : def.default;
    }
    case 'string':
      return typeof raw === 'string' ? raw.slice(0, def.maxLength) : def.default;
    case 'timeframe': {
      const allowed = def.options ?? TIMEFRAMES.map((t) => t.value);
      return typeof raw === 'string' && (allowed as readonly string[]).includes(raw)
        ? raw
        : def.default;
    }
  }
}

/** Fills defaults and validates every input (unknown keys are dropped). */
export function resolveInputs<I extends InputDefs>(
  defs: I,
  raw: RawInputs | undefined,
): InputValues<I> {
  const out: Record<string, InputValue> = {};
  for (const [k, d] of Object.entries(defs)) out[k] = validateInput(d, raw?.[k]);
  return out as InputValues<I>;
}

export function defaultInputs<I extends InputDefs>(defs: I): InputValues<I> {
  return resolveInputs(defs, undefined);
}

// ------------------------------------------------------------------ outputs

interface OutOpts {
  color2?: string;
  color3?: string;
  width?: number;
  style?: LineStyle;
  opacity?: number;
  visible?: boolean;
  priceTag?: boolean;
  unit?: OutputDef['unit'];
  legend?: boolean;
  baseline?: number;
}

function mk<K extends OutputKind>(kind: K) {
  return (label: string, color: string, o: OutOpts = {}): OutputDef & { kind: K } => ({
    kind,
    label,
    color,
    ...o,
  });
}

/** Output builders (default styles come from the HT design tokens, see `HT`). */
export const output = {
  line: mk('line'),
  step: mk('step'),
  area: mk('area'),
  histogram: mk('histogram'),
  band: mk('band'),
  dots: mk('dots'),
  bars: mk('bars'),
  markers: mk('markers'),
  levels: mk('levels'),
  zones: mk('zones'),
};

/**
 * Design-token colours (dark theme, docs/ARCHITECTURE "Design system"). Colour is reserved for
 * market meaning: up/down for direction, warning/info/special for categories; neutral lines use
 * white / soft grey.
 */
export const HT = {
  white: '#FFFFFF',
  soft: '#BDBDBD',
  grey: '#8C8C8C',
  dim: '#5E5E5E',
  up: '#20C77A',
  down: '#F04A5D',
  downSoft: '#F28A96',
  warning: '#E8B04B',
  info: '#4FA3F7',
  special: '#B07CF0',
} as const;
