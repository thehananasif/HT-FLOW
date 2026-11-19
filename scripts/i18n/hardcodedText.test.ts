import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanHardcoded } from './scanHardcoded';

/**
 * Fails when a main shell / settings / dashboard / auth / platform / shared component renders
 * hard-coded English: JSX text or a string in a user-visible prop (label, title, placeholder,
 * aria-label …) that does not go through `t()` / `tl()` / `tt`. Add the English to
 * packages/i18n/src/en.ts (and the Urdu to ur.ts), then wrap the text.
 */
const ROOT = 'apps/desktop/ui/src';
const DIRS = ['shell', 'modules/settings', 'dashboard', 'auth', 'platform', 'components'];

/** Text that is intentionally never translated: CSS variable names, brand names, code. */
const ALLOWED = new Set(['--ht-', 'HT Flow', 'HT FLOW', 'HANAN TRADE', 'HT', 'FLOW']);

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.tsx') && !e.name.endsWith('.test.tsx'))
    .map((e) => join(dir, e.name));
}

describe('no hard-coded English in the main UI', () => {
  for (const dir of DIRS) {
    it(dir, () => {
      const bad: string[] = [];
      for (const f of tsxFiles(join(ROOT, dir))) {
        for (const h of scanHardcoded(readFileSync(f, 'utf8'), f))
          if (!ALLOWED.has(h.text)) bad.push(`${f}:${h.line} [${h.kind}] ${h.text}`);
      }
      expect(bad).toEqual([]);
    });
  }

  it('the scanner flags text, props and toasts but not t() / tl() / tt', () => {
    const src = `
      const A = () => (
        <div title="Raw title">
          Raw text {tl('Fine')} {t('app.name')}
          <input aria-label={tt\`Help: \${x}\`} placeholder={'Raw'} />
        </div>
      );
      toast('info', 'Raw toast', tl('Fine body'));
    `;
    expect(scanHardcoded(src).map((h) => h.text)).toEqual([
      'Raw title',
      'Raw text',
      'Raw',
      'Raw toast',
    ]);
  });
});
