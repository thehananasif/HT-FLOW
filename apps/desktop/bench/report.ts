/**
 * Global setup of `pnpm bench`: clears the results file before the run and, after it, writes the
 * results table and the machine used into docs/PERFORMANCE.md between the bench markers (the
 * hand-written sections around them are kept). Set BENCH_NO_REPORT=1 to skip writing the file.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, platform, release, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESULTS_FILE, passes, type BenchResult } from './harness';

const DOC = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'docs',
  'PERFORMANCE.md',
);
const START = '<!-- bench:start -->';
const END = '<!-- bench:end -->';

export function setup(): void {
  rmSync(RESULTS_FILE, { force: true });
}

const fmt = (n: number) =>
  n >= 10_000
    ? Math.round(n).toLocaleString('en')
    : n >= 100
      ? n.toFixed(0)
      : n >= 10
        ? n.toFixed(1)
        : n.toFixed(2);

export function machine(): string {
  const c = cpus();
  return [
    `- CPU: ${c[0]?.model.trim() ?? 'unknown'} (${c.length} logical cores)`,
    `- RAM: ${(totalmem() / 2 ** 30).toFixed(0)} GB`,
    `- Load average at the end of the run: ${loadavg()
      .map((x) => x.toFixed(2))
      .join(' / ')} (other work on the machine inflates p95)`,
    `- OS: ${platform()} ${release()}`,
    `- Node.js ${process.version}, Vitest (jsdom for the canvas modules), headless 2D context`,
    `- Run: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
  ].join('\n');
}

export function renderTable(results: readonly BenchResult[]): string {
  const groups = [...new Set(results.map((r) => r.group))];
  const out: string[] = [];
  for (const g of groups) {
    out.push(`### ${g}`, '');
    out.push('| Measurement | Spec target | Budget | Median | p95 | Result |');
    out.push('| --- | --- | --- | --- | --- | --- |');
    for (const r of results.filter((x) => x.group === g)) {
      const unit = r.unit === 'prints/s' || r.unit === 'ticks/s' ? ` ${r.unit}` : ' ms';
      const budget = `${r.higherIsBetter ? '≥ ' : '≤ '}${fmt(r.budget)}${unit}`;
      const res = passes(r) ? 'Pass' : '**Miss**';
      const note = r.notes ? ` — ${r.notes}` : '';
      out.push(
        `| ${r.name}${note} | ${r.target} | ${budget} | ${fmt(r.median)}${unit} | ${fmt(r.p95)}${unit} | ${res} |`,
      );
    }
    out.push('');
  }
  return out.join('\n');
}

export function teardown(): void {
  if (process.env.BENCH_NO_REPORT || !existsSync(RESULTS_FILE)) return;
  const results = readFileSync(RESULTS_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as BenchResult);
  if (!results.length) return;
  const block = [
    START,
    '',
    '## Machine',
    '',
    machine(),
    '',
    '## Results',
    '',
    renderTable(results),
    END,
  ].join('\n');
  const doc = existsSync(DOC) ? readFileSync(DOC, 'utf8') : `# Performance\n\n${START}\n${END}\n`;
  const a = doc.indexOf(START);
  const b = doc.indexOf(END);
  const next =
    a >= 0 && b > a ? doc.slice(0, a) + block + doc.slice(b + END.length) : `${doc}\n${block}\n`;
  writeFileSync(DOC, next);
  console.info(`[bench] wrote ${results.length} results to docs/PERFORMANCE.md`);
}
