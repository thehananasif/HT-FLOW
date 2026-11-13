import { normalizeAlerts, type IndicatorAlert } from './alerts';
import { isSeriesKind } from './buffers';
import { isColor, resolveInputs } from './inputs';
import { TF_CLASSES, type TfClass } from './periods';
import type {
  AnyIndicator,
  InputDefs,
  InputValues,
  LineStyle,
  OutputDef,
  OutputStyle,
  RawInputs,
  TimeframeId,
} from './types';

/** One indicator on one chart, as saved in ChartWindowState.ext.indicators. */
export interface IndicatorConfig {
  uid: string;
  /** IndicatorDefinition.id */
  type: string;
  /** Eye toggle. */
  enabled: boolean;
  inputs: RawInputs;
  styles: Record<string, OutputStyle>;
  /** Chart timeframe classes where the indicator is shown. */
  visibility: TfClass[];
  /** 'overlay' = price pane, 'new' = own sub-pane, otherwise the uid of the indicator whose pane it joins. */
  pane: string;
  /** Overlay: 'merged' = price scale. Pane: 'merged' = shares the pane's scale. 'own' = independent. */
  scale: 'own' | 'merged';
  /** Draw above ('top') or below ('bottom') the price bars. */
  z: 'top' | 'bottom';
  /** Sub-pane height in px. */
  height: number;
  /** Timeframe override (MTF): 'chart' = the chart's own bars. */
  tf: TimeframeId;
  /** With a timeframe override: last closed higher-timeframe bar or the forming one. */
  tfMode: 'closed' | 'live';
  /** Data source: '' = the chart's instrument, else another instrument id (overlay symbol). */
  symbol: string;
  /** Alerts on this indicator's outputs (Alerts tab). */
  alerts: IndicatorAlert[];
}

export interface IndicatorsExt {
  v: 1;
  items: IndicatorConfig[];
}

export const EMPTY_EXT: IndicatorsExt = { v: 1, items: [] };
export const PANE_HEIGHT = { min: 40, max: 400, default: 100 };

export function defaultStyle(o: OutputDef): OutputStyle {
  return {
    color: o.color,
    color2: o.color2 ?? o.color,
    color3: o.color3 ?? o.color2 ?? o.color,
    width: o.width ?? (o.kind === 'line' || o.kind === 'step' || o.kind === 'area' ? 1.5 : 1),
    style: o.style ?? 'solid',
    opacity: o.opacity ?? 1,
    visible: o.visible ?? true,
    label: o.label,
    priceTag: o.priceTag ?? false,
  };
}

const LINE_STYLES: LineStyle[] = ['solid', 'dashed', 'dotted'];

/** Validates a saved style against the output's defaults (bad fields fall back). */
export function resolveStyle(o: OutputDef, raw: Partial<OutputStyle> | undefined): OutputStyle {
  const d = defaultStyle(o);
  if (!raw || typeof raw !== 'object') return d;
  const num = (x: unknown, lo: number, hi: number, def: number) =>
    typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : def;
  return {
    color: isColor(raw.color) ? raw.color : d.color,
    color2: isColor(raw.color2) ? raw.color2 : d.color2,
    color3: isColor(raw.color3) ? raw.color3 : d.color3,
    width: num(raw.width, 0.5, 8, d.width),
    style: LINE_STYLES.includes(raw.style as LineStyle) ? (raw.style as LineStyle) : d.style,
    opacity: num(raw.opacity, 0, 1, d.opacity),
    visible: typeof raw.visible === 'boolean' ? raw.visible : d.visible,
    label: typeof raw.label === 'string' ? raw.label.slice(0, 32) : d.label,
    priceTag: typeof raw.priceTag === 'boolean' ? raw.priceTag : d.priceTag,
  };
}

export function resolveStyles(
  def: AnyIndicator,
  raw: Record<string, Partial<OutputStyle>> | undefined,
): Record<string, OutputStyle> {
  const out: Record<string, OutputStyle> = {};
  for (const [k, o] of Object.entries(def.outputs)) out[k] = resolveStyle(o, raw?.[k]);
  return out;
}

let uidSeq = 0;
export function newUid(): string {
  uidSeq = (uidSeq + 1) % 1e6;
  return `i${Date.now().toString(36)}${uidSeq.toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

export const ALL_TF: TfClass[] = TF_CLASSES.map((c) => c.value);

/** A new instance with all defaults. */
export function createConfig(def: AnyIndicator, uid = newUid()): IndicatorConfig {
  return {
    uid,
    type: def.id,
    enabled: true,
    inputs: { ...resolveInputs(def.inputs, undefined) },
    styles: resolveStyles(def, undefined),
    visibility: ALL_TF.slice(),
    pane: def.pane,
    scale: def.pane === 'overlay' ? (def.overlayScale ?? 'merged') : 'own',
    z: 'top',
    height: PANE_HEIGHT.default,
    tf: 'chart',
    tfMode: 'closed',
    symbol: '',
    alerts: [],
  };
}

/** Series output ids of a definition (alert / MTF targets). */
export function seriesOutputIds(def: AnyIndicator): string[] {
  return Object.entries(def.outputs)
    .filter(([, o]) => isSeriesKind(o.kind))
    .map(([k]) => k);
}

/**
 * Validates saved extension data: unknown indicator types are dropped, inputs/styles are
 * resolved against their definitions, pane references to missing indicators become 'new'.
 */
export function normalizeExt(
  raw: unknown,
  lookup: (id: string) => AnyIndicator | undefined,
): IndicatorsExt {
  if (!raw || typeof raw !== 'object') return { v: 1, items: [] };
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items)) return { v: 1, items: [] };
  const out: IndicatorConfig[] = [];
  const seen = new Set<string>();
  for (const it of items as Partial<IndicatorConfig>[]) {
    if (!it || typeof it !== 'object' || typeof it.type !== 'string') continue;
    const def = lookup(it.type);
    if (!def) continue;
    const uid = typeof it.uid === 'string' && it.uid && !seen.has(it.uid) ? it.uid : newUid();
    seen.add(uid);
    const base = createConfig(def, uid);
    out.push({
      ...base,
      enabled: typeof it.enabled === 'boolean' ? it.enabled : true,
      inputs: { ...resolveInputs(def.inputs, it.inputs) },
      styles: resolveStyles(def, it.styles),
      visibility: Array.isArray(it.visibility)
        ? ALL_TF.filter((c) => (it.visibility as string[]).includes(c))
        : base.visibility,
      pane: typeof it.pane === 'string' && it.pane ? it.pane : base.pane,
      scale: it.scale === 'own' || it.scale === 'merged' ? it.scale : base.scale,
      z: it.z === 'bottom' ? 'bottom' : 'top',
      height:
        typeof it.height === 'number' && Number.isFinite(it.height)
          ? Math.round(Math.min(PANE_HEIGHT.max, Math.max(PANE_HEIGHT.min, it.height)))
          : base.height,
      tf: ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D', 'W', 'MN'].includes(it.tf as string)
        ? (it.tf as TimeframeId)
        : 'chart',
      tfMode: it.tfMode === 'live' ? 'live' : 'closed',
      symbol: typeof it.symbol === 'string' ? it.symbol.slice(0, 80) : '',
      alerts: normalizeAlerts(it.alerts, seriesOutputIds(def)),
    });
  }
  // Pane references must point at an earlier indicator that is in a sub-pane.
  for (let k = 0; k < out.length; k++) {
    const c = out[k]!;
    if (c.pane === 'overlay' || c.pane === 'new') continue;
    const target = out.slice(0, k).find((x) => x.uid === c.pane);
    if (!target || target.pane === 'overlay') c.pane = 'new';
  }
  return { v: 1, items: out };
}

/** Legend / list title, e.g. "EMA 21 close". */
export function titleOf(def: AnyIndicator, inputs: RawInputs): string {
  const vals = resolveInputs(def.inputs, inputs) as InputValues<InputDefs>;
  if (def.title) return def.title(vals);
  return def.short ?? def.name;
}

/** Pane layout: groups sub-pane indicators (in list order) into stacked panes. */
export function paneGroups(items: IndicatorConfig[]): IndicatorConfig[][] {
  const groups: IndicatorConfig[][] = [];
  const byLeader = new Map<string, IndicatorConfig[]>();
  for (const c of items) {
    if (c.pane === 'overlay') continue;
    if (c.pane !== 'new') {
      // Find the group containing the referenced indicator.
      const g = [...byLeader.values()].find((grp) => grp.some((x) => x.uid === c.pane));
      if (g) {
        g.push(c);
        continue;
      }
    }
    const g = [c];
    groups.push(g);
    byLeader.set(c.uid, g);
  }
  return groups;
}

/** Where an indicator is dropped: the price pane, a new sub-pane, or the pane led by a uid. */
export type PaneTarget = 'overlay' | 'new' | { join: string };

/**
 * Moves one indicator to another pane (drag & drop, P13). Joining a pane places the item right
 * after the last member of that pane so the "pane refers to an earlier indicator" rule holds;
 * when the moved item led a pane, its followers keep their pane under the next member.
 */
export function movePane(
  items: IndicatorConfig[],
  uid: string,
  target: PaneTarget,
): IndicatorConfig[] {
  const me = items.find((c) => c.uid === uid);
  if (!me) return items;
  if (typeof target === 'object' && target.join === uid) return items;
  // Re-home followers that referenced the moved item.
  const followers = items.filter((c) => c.pane === uid);
  let rest = items.filter((c) => c.uid !== uid);
  if (followers.length) {
    const lead = followers[0]!.uid;
    rest = rest.map((c) =>
      c.uid === lead ? { ...c, pane: 'new' } : c.pane === uid ? { ...c, pane: lead } : c,
    );
  }
  if (target === 'overlay' || target === 'new') {
    const scale = target === 'overlay' ? me.scale : me.pane === 'overlay' ? 'own' : me.scale;
    return [...rest, { ...me, pane: target, scale }];
  }
  const groups = paneGroups(rest);
  const g = groups.find((grp) => grp.some((c) => c.uid === target.join));
  if (!g) return items;
  const leader = g[0]!.uid;
  const last = g[g.length - 1]!.uid;
  const at = rest.findIndex((c) => c.uid === last);
  const moved: IndicatorConfig = {
    ...me,
    pane: leader,
    scale: me.pane === 'overlay' ? 'own' : me.scale,
  };
  return [...rest.slice(0, at + 1), moved, ...rest.slice(at + 1)];
}
