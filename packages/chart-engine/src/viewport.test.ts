import { describe, expect, it } from 'vitest';
import {
  appendedSlots,
  fitSlotWidth,
  isAnchored,
  offsetAfterGrowth,
  viewportStats,
} from './chartCore';

describe('viewport anchoring (follow the newest bar)', () => {
  it('counts as anchored only near the right margin', () => {
    expect(isAnchored(1, 1, 118)).toBe(true);
    expect(isAnchored(0.6, 1, 118)).toBe(true);
    expect(isAnchored(1.9, 1, 118)).toBe(true);
    expect(isAnchored(3, 1, 118)).toBe(false); // panned into the history
    expect(isAnchored(-2, 1, 118)).toBe(false); // newest bar pushed off the right edge
    // Thin slots (heatmap 2.5 px): the tolerance is ~12 px, not one slot.
    expect(isAnchored(33, 30, 2.5)).toBe(true);
    expect(isAnchored(40, 30, 2.5)).toBe(false);
  });

  it('following keeps the newest bar at the margin; panned keeps the view still', () => {
    const times = [0, 1, 2, 3, 4];
    const at = (i: number) => times[i]!;
    let prevLast = at(times.length - 1);
    times.push(5, 6); // two new bars
    const added = appendedSlots(at, times.length, prevLast);
    expect(added).toBe(2);
    expect(offsetAfterGrowth(1, added, true)).toBe(1); // follow: same distance from the edge
    expect(offsetAfterGrowth(20, added, false)).toBe(18); // panned: bars on screen stay put
    prevLast = at(times.length - 1);
    // A replay seek backwards rebuilds fewer bars: nothing appended, offset untouched.
    times.length = 3;
    expect(appendedSlots(at, times.length, prevLast)).toBe(0);
  });

  it('reports where the newest bar sits and how many bars are left of it', () => {
    // Plot 0..1000 px, 10 px slots, newest slot (index 299) 15 px from the right edge.
    const s = viewportStats(985, 299 - 98.5, 299, 0, 1000);
    expect(s.lastX).toBeCloseTo(0.985);
    expect(s.barsLeft).toBe(98);
    // Single bar in the middle of an empty plot (the preview-6 bug): nothing to its left.
    const lone = viewportStats(500, -50, 0, 0, 1000);
    expect(lone.lastX).toBe(0.5);
    expect(lone.barsLeft).toBe(0);
  });

  it('shrinks very wide bars so a narrow plot still shows several of them', () => {
    // Footprint 118 px bars in a 435 px plot: 3 bars + the 1-slot margin fit at ~97 px.
    expect(fitSlotWidth(118, 435, 3 + 1 + 0.5, 1)).toBeCloseTo(96.7, 1);
    // Wide plot: the preferred width is kept.
    expect(fitSlotWidth(118, 2000, 4.5, 1)).toBe(118);
    // Never below the minimum slot width.
    expect(fitSlotWidth(118, 3, 4.5, 1)).toBe(1);
    expect(fitSlotWidth(118, 0, 4.5, 1)).toBe(118);
  });
});
