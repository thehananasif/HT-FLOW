import { it } from 'vitest';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanHardcoded } from './scanHardcoded';

function walk(d: string, out: string[] = []): string[] {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx') && !p.endsWith('.test.tsx')) out.push(p);
  }
  return out;
}
it('scan', () => {
  const root = 'apps/desktop/ui/src';
  const res: Record<string, number> = {};
  const lines: string[] = [];
  for (const f of walk(root)) {
    const r = scanHardcoded(readFileSync(f, 'utf8'), f);
    if (r.length) res[f] = r.length;
    for (const h of r) lines.push(`${f.replace(root + '/', '')}:${h.line}\t${h.kind}\t${h.text}`);
  }
  writeFileSync(process.env.OUT!, lines.join('\n'));
  const tot = Object.entries(res).sort((a, b) => b[1] - a[1]);
  console.log(tot.reduce((s, [, n]) => s + n, 0), tot.slice(0, 40).map(([f, n]) => `${n} ${f}`).join('\n'));
});
