import { describe, expect, it, vi } from 'vitest';
import {
  entriesToText,
  filterEntries,
  formatEntry,
  LogBuffer,
  stringifyArgs,
  type LogEntry,
} from './log';

describe('LogBuffer', () => {
  it('keeps only the newest `capacity` entries (ring)', () => {
    const b = new LogBuffer(3);
    for (let i = 1; i <= 5; i++) b.add('info', 'app', `m${i}`);
    expect(b.snapshot().map((e) => e.message)).toEqual(['m3', 'm4', 'm5']);
    expect(b.size).toBe(3);
  });

  it('ids increase monotonically even after eviction', () => {
    const b = new LogBuffer(2);
    const ids = [1, 2, 3, 4].map(() => b.add('info', 's', 'x').id);
    expect(ids).toEqual([1, 2, 3, 4]);
  });

  it('rejects invalid capacity and defaults a blank source', () => {
    expect(() => new LogBuffer(0)).toThrow();
    expect(new LogBuffer(5).add('warn', '  ', 'x').source).toBe('app');
  });

  it('notifies subscribers, changes snapshot identity and supports unsubscribe', () => {
    const b = new LogBuffer(10);
    const fn = vi.fn();
    const un = b.subscribe(fn);
    const s0 = b.snapshot();
    b.add('info', 'a', 'x');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(b.snapshot()).not.toBe(s0);
    b.clear();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(b.size).toBe(0);
    un();
    b.add('info', 'a', 'y');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('lists distinct sorted sources', () => {
    const b = new LogBuffer(10);
    b.add('info', 'replay', '1');
    b.add('info', 'chart', '2');
    b.add('info', 'replay', '3');
    expect(b.sources()).toEqual(['chart', 'replay']);
  });
});

describe('filterEntries', () => {
  const mk = (id: number, level: LogEntry['level'], source: string, message: string): LogEntry => ({
    id,
    ts: 0,
    level,
    source,
    message,
  });
  const all = [
    mk(1, 'debug', 'chart', 'draw frame'),
    mk(2, 'info', 'replay', 'Started'),
    mk(3, 'warn', 'feed', 'Reconnecting'),
    mk(4, 'error', 'feed', 'Socket closed'),
  ];

  it('filters by minimum level', () => {
    expect(filterEntries(all, { minLevel: 'warn' }).map((e) => e.id)).toEqual([3, 4]);
  });
  it('filters by source', () => {
    expect(filterEntries(all, { source: 'feed' }).map((e) => e.id)).toEqual([3, 4]);
  });
  it('searches message and source case-insensitively', () => {
    expect(filterEntries(all, { query: 'SOCKET' }).map((e) => e.id)).toEqual([4]);
    expect(filterEntries(all, { query: 'replay' }).map((e) => e.id)).toEqual([2]);
  });
  it('combines filters', () => {
    expect(
      filterEntries(all, { minLevel: 'error', source: 'feed', query: 'sock' }),
    ).toHaveLength(1);
    expect(filterEntries(all, { minLevel: 'error', source: 'chart' })).toHaveLength(0);
  });
});

describe('formatting', () => {
  it('formats a line with level and source tag', () => {
    const line = formatEntry({ id: 1, ts: 0, level: 'warn', source: 'feed', message: 'slow' });
    expect(line).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} WARN {2}\[feed\] slow$/);
  });
  it('exports newline-terminated text, empty for no entries', () => {
    expect(entriesToText([])).toBe('');
    const t = entriesToText([
      { id: 1, ts: 0, level: 'info', source: 'a', message: 'x' },
      { id: 2, ts: 0, level: 'info', source: 'a', message: 'y' },
    ]);
    expect(t.split('\n')).toHaveLength(3);
  });
  it('stringifies mixed console arguments', () => {
    expect(stringifyArgs(['a', 1, { k: 2 }])).toBe('a 1 {"k":2}');
    expect(stringifyArgs([new Error('boom')])).toContain('boom');
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(stringifyArgs([cyc])).toBe('[object Object]');
  });
});
