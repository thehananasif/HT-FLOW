import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { en, t } from '@htflow/i18n';

const source = readFileSync(new URL('./index.tsx', import.meta.url), 'utf8');

describe('AI page strings come from the i18n package', () => {
  const used = [...source.matchAll(/\bt\(\s*'(ai\.[\w.]+)'/g)].map((m) => m[1]!);

  it('uses a meaningful number of keys and every key is defined', () => {
    expect(used.length).toBeGreaterThan(60);
    for (const k of used) expect(Object.keys(en), k).toContain(k);
  });

  it('has no JSX label left as a hard-coded English literal', () => {
    for (const lit of ['>Send<', '>Regenerate<', 'aria-label="Provider"', 'Start agent\n']) {
      expect(source.includes(lit), lit).toBe(false);
    }
  });

  it('interpolates variables', () => {
    expect(t('ai.usage' as keyof typeof en, { input: 12, output: 34 })).toBe('12 in · 34 out');
    expect(t('ai.deleteChat' as keyof typeof en, { title: 'Chat 1' })).toBe('Delete Chat 1');
    expect(t('ai.toolCalls' as keyof typeof en, { n: 3 })).toBe('3 tool calls');
  });
});
