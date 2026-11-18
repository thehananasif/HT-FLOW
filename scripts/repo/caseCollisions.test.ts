// Windows (and the Windows CI / release runners) use a case-insensitive file system: two files whose
// paths differ only in letter case (`Markdown.tsx` next to `markdown.ts`) collide there, and an
// extension-less import such as `./Markdown` resolves to the wrong file. Linux does not notice, so
// guard it here, where every developer and CI run executes it.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');

/** Tracked files, or null when git is not available (e.g. a source tarball). */
function trackedFiles(): string[] | null {
  try {
    return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    return null;
  }
}

/** Paths that collide on a case-insensitive file system, compared with and without extensions. */
export function caseCollisions(paths: readonly string[]): string[][] {
  const groups = new Map<string, Set<string>>();
  const add = (key: string, path: string) => {
    const set = groups.get(key) ?? new Set<string>();
    set.add(path);
    groups.set(key, set);
  };
  for (const p of paths) {
    add(`f:${p.toLowerCase()}`, p);
    // Module specifiers usually omit the extension: `./Markdown` must not match two files.
    const stem = p.replace(/\.(tsx?|jsx?|mjs|cjs)$/, '');
    if (stem !== p) add(`m:${stem.toLowerCase()}`, stem);
  }
  return [...groups.values()].filter((s) => s.size > 1).map((s) => [...s].sort());
}

describe('case-insensitive file names', () => {
  it('detects colliding paths', () => {
    expect(caseCollisions(['a/Markdown.tsx', 'a/markdown.ts', 'a/b.ts'])).toEqual([
      ['a/Markdown', 'a/markdown'],
    ]);
    expect(caseCollisions(['a/X.ts', 'a/x.ts'])).toHaveLength(2);
    expect(caseCollisions(['a/icon.png', 'a/icon.ico', 'a/Grid.tsx', 'a/Grid.css'])).toEqual([]);
  });

  it('no two tracked files differ only in letter case', () => {
    const files = trackedFiles();
    if (!files) return;
    expect(caseCollisions(files)).toEqual([]);
  });
});
