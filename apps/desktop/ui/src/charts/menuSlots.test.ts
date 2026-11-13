import { describe, expect, it } from 'vitest';
import { extSlot, slotExtensionItems } from './menuSlots';

describe('chart menu extension slots', () => {
  it('places extension items in the P26 order slots', () => {
    expect(extSlot('indicators')).toBe('indicators');
    expect(extSlot('dr-objects')).toBe('drawing');
    expect(extSlot('dr-edit')).toBe('context');
    expect(extSlot('ind-remove-x')).toBe('context');
    expect(extSlot('ctr-cancel')).toBe('context');
    expect(extSlot('ctr-more')).toBe('trade');
    expect(extSlot('alerts-set')).toBe('trade');
    expect(extSlot('ctr-toggle')).toBe('trading');
    expect(extSlot('strategy-live')).toBe('strategies');
    expect(extSlot('replay-template')).toBe('replay');
    expect(extSlot('ct-tf')).toBe('more');
  });

  it('drops extension separators', () => {
    const out = slotExtensionItems([
      { kind: 'separator', id: 'dr-s0' },
      { id: 'dr-edit', label: 'Edit', onSelect: () => {} },
      { id: 'indicators', label: 'Indicators', onSelect: () => {} },
    ]);
    expect(out.context.map((e) => e.id)).toEqual(['dr-edit']);
    expect(out.indicators).toHaveLength(1);
    expect(out.more).toEqual([]);
  });
});
