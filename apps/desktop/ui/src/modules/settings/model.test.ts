import { describe, expect, it } from 'vitest';
import { EXCHANGES, engineFields, exchangeStatus, resolveCommission } from './model';
import type { CommissionRule } from '../../state/settings';

const ex = (id: string) => EXCHANGES.find((e) => e.id === id)!;

describe('trading hours', () => {
  it('NYSE is open on a Wednesday afternoon and closed on Saturday', () => {
    expect(exchangeStatus(ex('nyse'), new Date('2026-03-04T15:00:00Z')).open).toBe(true); // 10:00 ET
    expect(exchangeStatus(ex('nyse'), new Date('2026-03-07T15:00:00Z')).open).toBe(false);
  });
  it('CME Globex: closed during the daily halt, open Sunday evening', () => {
    expect(exchangeStatus(ex('cme'), new Date('2026-03-04T22:30:00Z')).open).toBe(false); // 16:30 CT
    expect(exchangeStatus(ex('cme'), new Date('2026-03-08T23:30:00Z')).open).toBe(true); // Sun 18:30 CDT
  });
  it('crypto never closes', () => {
    expect(exchangeStatus(ex('crypto'), new Date('2026-03-07T03:00:00Z')).open).toBe(true);
  });
});

describe('commission rules', () => {
  const defaults = { makerPct: 0.02, takerPct: 0.05, perContractRT: 4.5 };
  const rule = (
    id: string,
    accountId: string,
    instrumentId: string,
    rt: number,
  ): CommissionRule => ({
    id,
    accountId,
    instrumentId,
    makerPct: 0,
    takerPct: 0.04,
    perContractRT: rt,
    source: 'manual',
  });
  const rules = [
    rule('a', 'acc1', '*', 3),
    rule('i', '*', 'mock:ESZ6', 2),
    rule('ai', 'acc1', 'mock:ESZ6', 1),
  ];
  it('picks the most specific rule', () => {
    expect(resolveCommission(rules, defaults, 'acc1', 'mock:ESZ6').ruleId).toBe('ai');
    expect(resolveCommission(rules, defaults, 'acc2', 'mock:ESZ6').ruleId).toBe('i');
    expect(resolveCommission(rules, defaults, 'acc1', 'mock:CLZ6').ruleId).toBe('a');
    expect(resolveCommission(rules, defaults, 'acc2', 'mock:CLZ6')).toEqual({
      ...defaults,
      ruleId: null,
    });
  });
  it('maps to paper-engine fields', () => {
    expect(engineFields(defaults, true)).toEqual({ commissionPerUnit: 2.25, takerFee: 0 });
    expect(engineFields(defaults, false)).toEqual({ commissionPerUnit: 0, takerFee: 0.0005 });
  });
});
