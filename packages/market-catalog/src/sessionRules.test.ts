import { describe, expect, it } from 'vitest';
import { SESSIONS } from './seed/common';
import { sessionRules } from './sessionRules';

// 2026-03-04 is a Wednesday; Chicago is UTC-6 (CST) on that date.
const ct = (h: number, m = 0, day = 4) => Date.UTC(2026, 2, day, h + 6, m);

describe('sessionRules', () => {
  it('RTH filters to the day session and anchors daily bars at its open', () => {
    const r = sessionRules(SESSIONS.cmeEquity, 'rth')!;
    expect(r.inSession(ct(9))).toBe(true);
    expect(r.inSession(ct(16))).toBe(false);
    expect(r.sessionStart(ct(12, 15))).toBe(ct(8, 30));
  });

  it('ETH spans the overnight Globex session from 17:00 the previous day', () => {
    const r = sessionRules(SESSIONS.cmeEquity, 'eth')!;
    expect(r.inSession(ct(16, 30))).toBe(false); // daily halt
    expect(r.inSession(ct(3))).toBe(true);
    expect(r.sessionStart(ct(3))).toBe(ct(17, 0, 3));
    expect(r.sessionStart(ct(18))).toBe(ct(17));
  });

  it('crypto 24/7 needs no filter; custom windows use the exchange zone', () => {
    expect(sessionRules(SESSIONS.crypto, 'eth')).toBeNull();
    expect(sessionRules(SESSIONS.crypto, 'rth')).toBeNull();
    const c = sessionRules(SESSIONS.cmeEquity, { open: '10:00', close: '11:00' })!;
    expect(c.inSession(ct(10, 30))).toBe(true);
    expect(c.inSession(ct(11, 30))).toBe(false);
    expect(sessionRules(SESSIONS.cmeEquity, { open: 'x', close: '11:00' })).toBeNull();
  });
});
