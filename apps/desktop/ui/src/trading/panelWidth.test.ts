import { describe, expect, it } from 'vitest';
import {
  PANEL_DEFAULT_WIDTH,
  clampPanelWidth,
  panelWidthOf,
  panelWidthStore,
  setPanelWidth,
} from './panelWidth';

describe('panel width', () => {
  it('clamps to the 240 px minimum, the 560 px maximum and 60% of the window', () => {
    expect(clampPanelWidth(100)).toBe(240);
    expect(clampPanelWidth(300)).toBe(300);
    expect(clampPanelWidth(900)).toBe(560);
    expect(clampPanelWidth(900, 800)).toBe(480);
    expect(clampPanelWidth(900, 300)).toBe(240);
    expect(clampPanelWidth(Number.NaN)).toBe(PANEL_DEFAULT_WIDTH);
  });
  it('saves per panel id and null resets', () => {
    setPanelWidth('a', 320);
    setPanelWidth('b', 400);
    expect(panelWidthOf(panelWidthStore.get(), 'a')).toBe(320);
    expect(panelWidthOf(panelWidthStore.get(), 'b')).toBe(400);
    setPanelWidth('a', null);
    expect(panelWidthOf(panelWidthStore.get(), 'a')).toBe(PANEL_DEFAULT_WIDTH);
    expect(panelWidthStore.get().a).toBeUndefined();
    expect(panelWidthStore.get().b).toBe(400);
  });
});
