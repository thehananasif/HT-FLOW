import { describe, expect, it } from 'vitest';
import { LockedSaves } from './lockedSaves';

describe('LockedSaves', () => {
  it('keeps the last value per key and hands it back to the same profile', () => {
    const q = new LockedSaves();
    q.started('p1');
    q.hold('alerts', '[1]');
    q.hold('alerts', '[1,2]');
    q.hold('journal', '{}');
    expect(q.size).toBe(2);
    const out = q.started('p1');
    expect([...out]).toEqual([
      ['alerts', '[1,2]'],
      ['journal', '{}'],
    ]);
    expect(q.size).toBe(0);
  });

  it('never writes one profile’s values into another', () => {
    const q = new LockedSaves();
    q.started('p1');
    q.hold('alerts', '[1]');
    expect(q.started('p2').size).toBe(0);
  });

  it('drops everything on logout and ignores saves with no session', () => {
    const q = new LockedSaves();
    q.hold('x', '1');
    expect(q.size).toBe(0);
    q.started('p1');
    q.hold('x', '1');
    q.clear();
    expect(q.started('p1').size).toBe(0);
  });
});
