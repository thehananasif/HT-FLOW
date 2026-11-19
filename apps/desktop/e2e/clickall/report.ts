/**
 * JSON + HTML report of the click-everything crawl (Node only, framework-agnostic).
 * Each test / shard writes `parts/<name>.json`; `mergeReport()` (Playwright global teardown, or
 * the WebdriverIO runner at the end) folds them into `report.json` and `index.html`.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { StepResult, SurfaceResult } from './core';

export interface ReportPart {
  name: string;
  runner: string;
  surfaces: SurfaceResult[];
  commands?: StepResult[];
  /** App bugs the crawler found and that were fixed (kept for the record). */
  fixed?: string[];
}

export interface Report {
  generatedAt: string;
  runner: string;
  totals: Record<'controls' | 'pass' | 'warn' | 'fail' | 'skip', number>;
  parts: ReportPart[];
  failures: string[];
  fixedBugs: string[];
}

/** Bugs this crawler found in the app and that were fixed (see docs/CHANGELOG.md, round 7). */
export const FIXED_BUGS: string[] = [
  'Chart › Snapshot (copy PNG): unhandled rejection when clipboard access is refused — now saves the PNG and says so',
  'Settings › Logs › Copy: false "copied" toast + unhandled rejection when the clipboard is denied — now "Copy failed"',
  'Create account › recovery code Copy: same clipboard rejection — now "Copy failed"',
];

export function writePart(dir: string, part: ReportPart): void {
  mkdirSync(join(dir, 'parts'), { recursive: true });
  const file = part.name.replace(/[^a-z0-9-]+/gi, '_');
  writeFileSync(join(dir, 'parts', `${file}.json`), JSON.stringify(part, null, 2));
}

function stepsOf(p: ReportPart): StepResult[] {
  return [...p.surfaces.flatMap((s) => s.steps), ...(p.commands ?? [])];
}

export function failuresOf(p: ReportPart): string[] {
  const out: string[] = [];
  for (const s of p.surfaces) {
    for (const e of s.errors) out.push(`${s.name}: while opening: ${e}`);
    for (const o of s.layout.overflow) out.push(`${s.name}: overflows its window: ${o}`);
    for (const o of s.layout.overlap) out.push(`${s.name}: overlapping text: ${o}`);
  }
  for (const st of stepsOf(p))
    if (st.status === 'fail') out.push(`${st.surface} › ${st.control}: ${st.notes.join(' | ')}`);
  return out;
}

export function buildReport(parts: ReportPart[], runner: string): Report {
  const totals = { controls: 0, pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const p of parts)
    for (const st of stepsOf(p)) {
      totals.controls++;
      totals[st.status]++;
    }
  return {
    generatedAt: new Date().toISOString(),
    runner,
    totals,
    parts: [...parts].sort((a, b) => a.name.localeCompare(b.name)),
    failures: parts.flatMap(failuresOf),
    fixedBugs: [...new Set([...FIXED_BUGS, ...parts.flatMap((p) => p.fixed ?? [])])],
  };
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function renderHtml(r: Report): string {
  const row = (st: StepResult) =>
    `<tr class="${st.status}"><td>${st.status}</td><td>${esc(st.surface)}</td><td>${esc(st.control)}</td><td>${esc(st.role)}</td><td>${esc(st.effect)}</td><td>${esc(st.notes.join(' | '))}</td></tr>`;
  const surfaces = r.parts
    .flatMap((p) => p.surfaces)
    .map(
      (
        s,
      ) => `<section><h3>${esc(s.group)} › ${esc(s.name)} <small>${s.steps.length} steps · ${s.durationMs} ms</small></h3>
${s.screenshot ? `<a href="${esc(s.screenshot)}"><img loading="lazy" src="${esc(s.screenshot)}" alt=""></a>` : ''}
${s.layout.overflow.length || s.layout.overlap.length ? `<ul class="bad">${[...s.layout.overflow.map((o) => `overflow: ${o}`), ...s.layout.overlap.map((o) => `overlap: ${o}`)].map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
<table><thead><tr><th>Result</th><th>Surface</th><th>Control</th><th>Role</th><th>Effect</th><th>Notes</th></tr></thead><tbody>${s.steps.map(row).join('')}</tbody></table></section>`,
    )
    .join('\n');
  const cmds = r.parts.flatMap((p) => p.commands ?? []);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>HT Flow click report</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font:13px/1.4 system-ui,sans-serif;margin:16px;background:#111418;color:#d8dde3}
h1{font-size:20px}h3{font-size:14px;margin:18px 0 6px}small{color:#8a96a3;font-weight:400}
table{border-collapse:collapse;width:100%;margin-bottom:8px}td,th{border-bottom:1px solid #2a3038;padding:3px 6px;text-align:left;vertical-align:top}
tr.fail td:first-child{color:#ff6b6b;font-weight:600}tr.warn td:first-child{color:#f0b429}tr.pass td:first-child{color:#4cc38a}tr.skip td{color:#7d8792}
img{max-width:480px;max-height:300px;border:1px solid #2a3038;display:block;margin:4px 0}
.totals span{margin-right:14px}.bad{color:#ff6b6b}
</style></head><body>
<h1>HT Flow — click-everything report</h1>
<p>${esc(r.runner)} · ${esc(r.generatedAt)}</p>
<p class="totals"><span>Controls: <b>${r.totals.controls}</b></span><span>Pass: <b>${r.totals.pass}</b></span><span>Warnings (no visible effect / not clickable): <b>${r.totals.warn}</b></span><span>Failures: <b>${r.totals.fail}</b></span><span>Skipped: <b>${r.totals.skip}</b></span></p>
<h2>Failures (${r.failures.length})</h2><ul class="bad">${r.failures.map((f) => `<li>${esc(f)}</li>`).join('') || '<li style="color:#4cc38a">none</li>'}</ul>
<h2>Bugs found by the crawler and fixed</h2><ul>${r.fixedBugs.map((f) => `<li>${esc(f)}</li>`).join('') || '<li>none recorded</li>'}</ul>
<h2>Surfaces</h2>${surfaces}
${cmds.length ? `<h2>Command Palette commands (${cmds.length})</h2><table><thead><tr><th>Result</th><th>Surface</th><th>Command</th><th>Role</th><th>Effect</th><th>Notes</th></tr></thead><tbody>${cmds.map(row).join('')}</tbody></table>` : ''}
</body></html>`;
}

/** Merges every `parts/*.json` under `dir` into `report.json` + `index.html`. */
export function mergeReport(dir: string, runner: string): Report | null {
  const partsDir = join(dir, 'parts');
  if (!existsSync(partsDir)) return null;
  const parts = readdirSync(partsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(partsDir, f), 'utf8')) as ReportPart);
  const r = buildReport(parts, runner);
  writeFileSync(join(dir, 'report.json'), JSON.stringify(r, null, 2));
  writeFileSync(join(dir, 'index.html'), renderHtml(r));
  return r;
}
