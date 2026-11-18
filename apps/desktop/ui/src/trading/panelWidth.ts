import { Persisted, usePersisted } from './persist';

/** Narrowest a panel may be (matches `.trading-panel { min-width }`). */
export const PANEL_MIN_WIDTH = 240;
export const PANEL_DEFAULT_WIDTH = 262;
export const PANEL_MAX_WIDTH = 560;

/** Clamps a requested width to [240, 560] and never more than `maxFraction` of the window. */
export function clampPanelWidth(w: number, viewport = 1600, maxFraction = 0.6): number {
  if (!Number.isFinite(w)) return PANEL_DEFAULT_WIDTH;
  const max = Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, viewport * maxFraction));
  return Math.round(Math.min(max, Math.max(PANEL_MIN_WIDTH, w)));
}

type Widths = Record<string, number>;

/** Panel width in px per panel id, saved per profile (settings key `ui.panelWidths`). */
export const panelWidthStore = new Persisted<Widths>(
  'ui.panelWidths',
  () => ({}),
  (raw) => {
    const out: Widths = {};
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v)) out[k] = clampPanelWidth(v);
      }
    }
    return out;
  },
);

export const panelWidthOf = (widths: Widths, id: string): number =>
  clampPanelWidth(widths[id] ?? PANEL_DEFAULT_WIDTH);

/** Stores a width; the default width is stored as "no override". */
export function setPanelWidth(id: string, w: number | null): void {
  panelWidthStore.update((all) => {
    const next = { ...all };
    if (w === null || clampPanelWidth(w) === PANEL_DEFAULT_WIDTH) delete next[id];
    else next[id] = clampPanelWidth(w);
    return next;
  });
}

export const usePanelWidths = (): Widths => usePersisted(panelWidthStore);
