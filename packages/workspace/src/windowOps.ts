/**
 * Window operations (P25): Clone window, Create linked window ▸, and link-group bookkeeping.
 */
import {
  chartState,
  domState,
  LINK_COLOR_IDS,
  type ChartTemplateId,
  type LinkColor,
  type WindowState,
} from './model';

/** Kinds offered by "Create linked window ▸" (P25). */
export type LinkedKind = 'chart' | 'footprint' | 'heatmap' | 'dom' | 'tape' | 'options';

export const LINKED_KINDS: { id: LinkedKind; label: string }[] = [
  { id: 'chart', label: 'Chart' },
  { id: 'dom', label: 'DOM' },
  { id: 'tape', label: 'Tape' },
  { id: 'heatmap', label: 'Heatmap' },
  { id: 'footprint', label: 'Footprint' },
  { id: 'options', label: 'Options' },
];

/** Window types whose "opens docked / floating" default is set in Layout settings. */
export type OpenModeType = 'chart' | 'dom' | 'tape' | 'module';
export type OpenMode = 'docked' | 'floating' | 'tab';

export function openModeType(s: WindowState): OpenModeType {
  if (s.kind === 'chart') return 'chart';
  if (s.kind === 'dom') return 'dom';
  return /tape/.test(s.module) ? 'tape' : 'module';
}

const deepClone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** "Clone window": an independent copy with every setting (template, colours, ext, params). */
export function cloneWindowState(s: WindowState): WindowState {
  return deepClone(s);
}

/** Instrument a window shows (module windows may carry one in params). */
export function windowInstrument(s: WindowState): string | null {
  if (s.kind !== 'module') return s.instrumentId;
  const p = s.params?.instrumentId;
  return typeof p === 'string' ? p : null;
}

export function windowLink(s: WindowState): LinkColor {
  if (s.kind !== 'module') return s.link;
  const l = s.params?.link;
  return typeof l === 'string' && (LINK_COLOR_IDS as string[]).includes(l)
    ? (l as LinkColor)
    : 'none';
}

/** First link colour no window uses yet (falls back to red when all are taken). */
export function freeLinkColor(windows: Record<string, WindowState>): LinkColor {
  const used = new Set(Object.values(windows).map(windowLink));
  return LINK_COLOR_IDS.find((c) => c !== 'none' && !used.has(c)) ?? 'red';
}

/**
 * "Create linked window ▸ <kind>": a new window on the source's instrument and link group. When the
 * source has no group yet, `sourceLink` is the colour to give the source too.
 */
export function linkedWindowState(
  source: WindowState,
  kind: LinkedKind,
  windows: Record<string, WindowState>,
  fallbackInstrument: string,
): { state: WindowState; sourceLink: LinkColor | null } {
  const instrumentId = windowInstrument(source) ?? fallbackInstrument;
  const cur = windowLink(source);
  const link = cur !== 'none' ? cur : freeLinkColor(windows);
  const sourceLink = cur === 'none' ? link : null;
  const chart = (t: ChartTemplateId) => chartState(instrumentId, t, { link });
  let state: WindowState;
  switch (kind) {
    case 'chart':
      state = chart(source.kind === 'chart' ? source.template : 'candles-vp');
      if (source.kind === 'chart' && state.kind === 'chart')
        state.timeframe = { ...source.timeframe };
      break;
    case 'footprint':
      state = chart('footprint');
      break;
    case 'heatmap':
      state = chart('liquidity-map');
      break;
    case 'dom':
      state = domState(instrumentId, { link });
      break;
    case 'tape':
      state = { kind: 'module', module: 'smart-tape', params: { instrumentId, link } };
      break;
    case 'options':
      state = { kind: 'module', module: 'options-board', params: { instrumentId, link } };
      break;
  }
  return { state, sourceLink };
}

export interface LinkGroupInfo {
  color: LinkColor;
  windowIds: string[];
  /** Instruments shown by the group's windows (normally one). */
  instruments: string[];
}

/** Every link group with its member windows ("none" lists unlinked windows). */
export function linkGroups(windows: Record<string, WindowState>): LinkGroupInfo[] {
  return LINK_COLOR_IDS.map((color) => {
    const ids = Object.keys(windows).filter((id) => windowLink(windows[id]!) === color);
    const instruments = [
      ...new Set(ids.map((id) => windowInstrument(windows[id]!)).filter((x): x is string => !!x)),
    ];
    return { color, windowIds: ids, instruments };
  });
}

/** Patch that moves a window into a link group (module windows keep it in params). */
export function setWindowLink(s: WindowState, link: LinkColor): WindowState {
  if (s.kind !== 'module') return { ...s, link };
  return { ...s, params: { ...(s.params ?? {}), link } };
}
