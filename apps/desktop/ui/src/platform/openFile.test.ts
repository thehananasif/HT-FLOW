import { describe, expect, it, vi } from 'vitest';
import {
  flushWaitingFiles,
  registerOpenFileHandler,
  routeOpenedFile,
  type OpenedFile,
} from './openFile';

const file = (kind: OpenedFile['kind'], over: Partial<OpenedFile> = {}): OpenedFile => ({
  path: `C:\\x\\a.ht${kind}`,
  name: `a.ht${kind}`,
  ext: `ht${kind}`,
  kind,
  text: '{}',
  error: null,
  ...over,
});

describe('open-file routing', () => {
  it('calls the handler registered for the kind', async () => {
    const fn = vi.fn();
    const off = registerOpenFileHandler('indicator', fn);
    expect(await routeOpenedFile(file('indicator'), true)).toBe('handled');
    expect(fn).toHaveBeenCalledOnce();
    off();
    expect(await routeOpenedFile(file('indicator'), true)).toBe('unhandled');
  });

  it('routes .htstrat files to the strategy handler', async () => {
    const fn = vi.fn();
    const off = registerOpenFileHandler('strategy', fn);
    expect(await routeOpenedFile(file('strategy', { ext: 'htstrat' }), true)).toBe('handled');
    expect(fn).toHaveBeenCalledOnce();
    off();
  });

  it('reports read errors without calling handlers', async () => {
    const fn = vi.fn();
    const off = registerOpenFileHandler('workspace', fn);
    expect(await routeOpenedFile(file('workspace', { error: 'File not found' }), true)).toBe(
      'error',
    );
    expect(fn).not.toHaveBeenCalled();
    off();
  });

  it('waits for a session when the handler needs one, then flushes', async () => {
    const fn = vi.fn();
    const off = registerOpenFileHandler('workspace', fn, { needsSession: true });
    expect(await routeOpenedFile(file('workspace'), false)).toBe('waiting');
    expect(fn).not.toHaveBeenCalled();
    await flushWaitingFiles();
    expect(fn).toHaveBeenCalledOnce();
    off();
  });

  it('a handler returning false counts as unhandled and a throw as error', async () => {
    const off = registerOpenFileHandler('template', () => false);
    expect(await routeOpenedFile(file('template'), true)).toBe('unhandled');
    off();
    const off2 = registerOpenFileHandler('template', () => {
      throw new Error('bad');
    });
    expect(await routeOpenedFile(file('template'), true)).toBe('error');
    off2();
  });
});
