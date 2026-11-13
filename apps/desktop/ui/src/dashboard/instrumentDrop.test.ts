import { describe, expect, it } from 'vitest';
import type { WindowState } from '@htflow/workspace';
import { decodePayload, encodePayload, resolveDrop, retargetPatch } from './instrumentDrop';

describe('instrument drag and drop', () => {
  it('round-trips and rejects bad payloads', () => {
    const p = { feedId: 'mock:CLZ6', key: 'cat:NYMEX:CL' };
    expect(decodePayload(encodePayload(p))).toEqual(p);
    expect(decodePayload('{"feedId":""}')).toBeNull();
    expect(decodePayload('nope')).toBeNull();
    expect(decodePayload(undefined)).toBeNull();
  });
  it('drop on a window retargets it; Ctrl or empty dock opens a new chart', () => {
    const p = { feedId: 'mock:ESZ6', key: 'k' };
    expect(resolveDrop(p, { ctrl: false, targetId: 'w1' })).toEqual({
      kind: 'retarget',
      windowId: 'w1',
      feedId: 'mock:ESZ6',
    });
    expect(resolveDrop(p, { ctrl: true, targetId: 'w1' }).kind).toBe('newChart');
    expect(resolveDrop(p, { ctrl: false, targetId: null }).kind).toBe('newChart');
  });
  it('module windows keep the instrument in their params', () => {
    const mod = { kind: 'module', module: 'heatmap', params: { a: 1 } } as unknown as WindowState;
    expect(retargetPatch(mod, 'f')).toEqual({ params: { a: 1, instrumentId: 'f' } });
    const chart = { kind: 'chart', instrumentId: 'x' } as unknown as WindowState;
    expect(retargetPatch(chart, 'f')).toEqual({ instrumentId: 'f' });
  });
});
