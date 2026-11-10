import type {
  Anchor,
  Drawing,
  DrawingsDoc,
  DrawingStyle,
  FibLevel,
  PropValue,
  ToolId,
} from './types';

export const DEFAULT_STYLE: DrawingStyle = {
  color: '#4FA3F7',
  opacity: 1,
  width: 1,
  dash: 'solid',
  fill: '',
  fillOpacity: 0.15,
  text: '',
  fontSize: 12,
};

/** Colour swatches offered by the style toolbar (market colours + greys). */
export const SWATCHES = [
  '#FFFFFF',
  '#BDBDBD',
  '#8C8C8C',
  '#4FA3F7',
  '#20C77A',
  '#F04A5D',
  '#E8B04B',
  '#B07CF0',
  '#F28A96',
  '#64C8D8',
];

const lv = (value: number, enabled = true): FibLevel => ({ value, color: '', enabled });

export const FIB_RETRACEMENT_LEVELS: FibLevel[] = [
  lv(0),
  lv(0.236),
  lv(0.382),
  lv(0.5),
  lv(0.618),
  lv(0.786),
  lv(1),
  lv(1.618, false),
  lv(2.618, false),
];
export const FIB_EXTENSION_LEVELS: FibLevel[] = [
  lv(0),
  lv(0.382),
  lv(0.618),
  lv(1),
  lv(1.272),
  lv(1.618),
  lv(2),
  lv(2.618, false),
];
export const FIB_FAN_LEVELS: FibLevel[] = [lv(0.236), lv(0.382), lv(0.5), lv(0.618), lv(0.786)];
export const FIB_TIME_LEVELS: FibLevel[] = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89].map((v) => lv(v));
export const FIB_ARC_LEVELS: FibLevel[] = [lv(0.382), lv(0.5), lv(0.618), lv(1)];
export const GANN_FAN_LEVELS: FibLevel[] = [1 / 8, 1 / 4, 1 / 3, 1 / 2, 1, 2, 3, 4, 8].map((v) =>
  lv(v),
);
export const GANN_BOX_LEVELS: FibLevel[] = [0, 0.25, 0.382, 0.5, 0.618, 0.75, 1].map((v) => lv(v));

let seq = 0;
export function newId(): string {
  seq = (seq + 1) % 1_000_000;
  return `d${Date.now().toString(36)}${seq.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export interface DrawingDefaults {
  style?: Partial<DrawingStyle>;
  extendLeft?: boolean;
  extendRight?: boolean;
  showLabels?: boolean;
  levels?: FibLevel[];
  props?: Record<string, PropValue>;
}

export function createDrawing(
  type: ToolId,
  anchors: Anchor[],
  defaults: DrawingDefaults = {},
  z = 0,
): Drawing {
  return {
    id: newId(),
    type,
    anchors: anchors.map((a) => ({ ...a })),
    style: { ...DEFAULT_STYLE, ...defaults.style },
    locked: false,
    hidden: false,
    extendLeft: defaults.extendLeft ?? false,
    extendRight: defaults.extendRight ?? false,
    showLabels: defaults.showLabels ?? false,
    visibleOn: 'all',
    z,
    sync: false,
    alert: false,
    levels: defaults.levels?.map((l) => ({ ...l })),
    props: { ...defaults.props },
    createdAt: Date.now(),
  };
}

export function cloneDrawing(d: Drawing, z = d.z): Drawing {
  return {
    ...d,
    id: newId(),
    anchors: d.anchors.map((a) => ({ ...a })),
    style: { ...d.style },
    levels: d.levels?.map((l) => ({ ...l })),
    props: { ...d.props },
    visibleOn: d.visibleOn === 'all' ? 'all' : [...d.visibleOn],
    locked: false,
    z,
    createdAt: Date.now(),
  };
}

export function maxZ(items: readonly Drawing[]): number {
  let z = 0;
  for (const d of items) if (d.z > z) z = d.z;
  return z;
}

export function isVisibleOn(d: Drawing, tfKey: string): boolean {
  return !d.hidden && (d.visibleOn === 'all' || d.visibleOn.includes(tfKey));
}

export function prop<T extends PropValue>(d: Drawing, key: string, fallback: T): T {
  const v = d.props[key];
  return (typeof v === typeof fallback ? v : fallback) as T;
}

// ---------------------------------------------------------------- serialisation

const num = (v: unknown, f: number) => (typeof v === 'number' && Number.isFinite(v) ? v : f);
const str = (v: unknown, f: string) => (typeof v === 'string' ? v : f);
const bool = (v: unknown, f: boolean) => (typeof v === 'boolean' ? v : f);

export function serialize(items: readonly Drawing[]): DrawingsDoc {
  return { v: 1, items: items.map((d) => ({ ...d })) };
}

function readStyle(raw: unknown): DrawingStyle {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const dash = s.dash === 'dashed' || s.dash === 'dotted' ? s.dash : 'solid';
  return {
    color: str(s.color, DEFAULT_STYLE.color),
    opacity: Math.min(1, Math.max(0, num(s.opacity, 1))),
    width: Math.min(8, Math.max(1, num(s.width, 1))),
    dash,
    fill: str(s.fill, ''),
    fillOpacity: Math.min(1, Math.max(0, num(s.fillOpacity, DEFAULT_STYLE.fillOpacity))),
    text: str(s.text, ''),
    fontSize: Math.min(48, Math.max(8, num(s.fontSize, 12))),
  };
}

/** Validates persisted data (any shape) into drawings; invalid entries are dropped. */
export function deserialize(raw: unknown, isTool: (t: string) => boolean = () => true): Drawing[] {
  const doc = raw as { v?: unknown; items?: unknown } | Drawing[] | null | undefined;
  const list: unknown[] = Array.isArray(doc) ? doc : Array.isArray(doc?.items) ? doc.items : [];
  const out: Drawing[] = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.type !== 'string' || !isTool(o.type) || !Array.isArray(o.anchors)) continue;
    const anchors: Anchor[] = [];
    for (const a of o.anchors) {
      const ao = a as Record<string, unknown> | null;
      if (ao && Number.isFinite(ao.t) && Number.isFinite(ao.px))
        anchors.push({ t: ao.t as number, px: ao.px as number });
    }
    if (!anchors.length) continue;
    const props: Record<string, PropValue> = {};
    if (o.props && typeof o.props === 'object')
      for (const [k, v] of Object.entries(o.props as Record<string, unknown>))
        if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') props[k] = v;
    const levels = Array.isArray(o.levels)
      ? (o.levels as unknown[])
          .filter((l) => l && typeof l === 'object' && Number.isFinite((l as FibLevel).value))
          .map((l) => {
            const x = l as Record<string, unknown>;
            return {
              value: x.value as number,
              color: str(x.color, ''),
              enabled: bool(x.enabled, true),
            };
          })
      : undefined;
    out.push({
      id: str(o.id, newId()),
      type: o.type as ToolId,
      anchors,
      style: readStyle(o.style),
      locked: bool(o.locked, false),
      hidden: bool(o.hidden, false),
      extendLeft: bool(o.extendLeft, false),
      extendRight: bool(o.extendRight, false),
      showLabels: bool(o.showLabels, false),
      visibleOn: Array.isArray(o.visibleOn)
        ? (o.visibleOn as unknown[]).filter((x): x is string => typeof x === 'string')
        : 'all',
      z: num(o.z, 0),
      sync: bool(o.sync, false),
      alert: bool(o.alert, false),
      levels,
      props,
      createdAt: num(o.createdAt, 0),
    });
  }
  return out;
}
