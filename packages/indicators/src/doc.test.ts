import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderCatalogDoc } from './doc';

const FILE = resolve(__dirname, '../../../docs/INDICATORS.md');

/** Ignores Prettier's column padding. */
const norm = (md: string) =>
  md
    .split('\n')
    .map((l) =>
      l.startsWith('|')
        ? l
            .split(/(?<!\\)\|/)
            .map((c) => c.trim().replace(/^-+$/, '---'))
            .join('|')
        : l.trimEnd(),
    )
    .join('\n')
    .replace(/\n+$/, '');

describe('docs/INDICATORS.md', () => {
  // UPDATE_INDICATOR_DOC=1 pnpm exec vitest run packages/indicators/src/doc.test.ts
  // && pnpm exec prettier --write docs/INDICATORS.md
  if (process.env.UPDATE_INDICATOR_DOC) {
    it('regenerates the file', () => {
      writeFileSync(FILE, renderCatalogDoc());
    });
  } else {
    it('is up to date with the catalog', () => {
      expect(norm(readFileSync(FILE, 'utf8'))).toBe(norm(renderCatalogDoc()));
    });
  }
});
