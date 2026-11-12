import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without types
import { buildLatestJson } from './latest-json.mjs';

describe('latest.json builder', () => {
  const base = {
    version: '0.2.0',
    notes: 'notes',
    pubDate: '2026-01-01T00:00:00.000Z',
    repo: 'o/r',
    tag: 'v0.2.0',
    installerName: 'HTFlow-v0.2.0-windows-x64-setup.exe',
    signature: 'SIG\n',
  };
  it('points the windows platforms at the release asset with the signature', () => {
    const j = buildLatestJson(base);
    expect(j.version).toBe('0.2.0');
    expect(j.platforms['windows-x86_64'].signature).toBe('SIG');
    expect(j.platforms['windows-x86_64'].url).toBe(
      'https://github.com/o/r/releases/download/v0.2.0/HTFlow-v0.2.0-windows-x64-setup.exe',
    );
    expect(j.platforms['windows-x86_64-nsis']).toEqual(j.platforms['windows-x86_64']);
  });
  it('requires a signature', () => {
    expect(() => buildLatestJson({ ...base, signature: '' })).toThrow();
  });
});
