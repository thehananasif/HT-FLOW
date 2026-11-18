import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { SECTIONS, SCHEMA } from './state/settings';
it('dump', () => {
  const out = new Set<string>();
  const add = (s: unknown) => {
    if (typeof s === 'string' && s.trim()) out.add(s);
  };
  for (const s of SECTIONS) {
    add(s.label);
    add(s.description);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const d of Object.values(SCHEMA) as any[]) {
    add(d.group);
    add(d.label);
    add(d.help);
    add(d.placeholder);
    add(d.patternHint);
    add(d.unit);
    for (const o of d.options ?? []) add(o.label);
    for (const o of d.special ?? []) add(o.label);
  }
  writeFileSync(process.env.OUT!, [...out].join('\n'));
});
