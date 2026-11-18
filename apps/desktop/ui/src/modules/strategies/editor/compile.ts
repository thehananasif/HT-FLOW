import { transform } from 'sucrase';
import { indicatorById } from '@htflow/indicators';
import {
  REALM_BLOCKED,
  forbiddenSyntax,
  type CompiledProject,
  type StrategyFile,
} from '@htflow/strategy';

/** An editor marker (1-based line, 0-based column). */
export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  message: string;
  severity: 'error' | 'warning';
}

export interface CompileOutput {
  project: CompiledProject | null;
  diagnostics: Diagnostic[];
}

/** Strips strings and comments (keeps line structure) so the lint regexes only see code. */
function codeOnly(src: string): string {
  return src.replace(
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g,
    (m) => (m.startsWith('/') ? m.replace(/[^\n]/g, ' ') : m[0] + m.slice(1, -1).replace(/[^\n]/g, ' ') + m.slice(-1)),
  );
}

function lineCol(src: string, index: number): { line: number; column: number } {
  const before = src.slice(0, index);
  const line = before.split('\n').length;
  return { line, column: index - before.lastIndexOf('\n') - 1 };
}

const RISKY = [...new Set([...REALM_BLOCKED, 'globalThis', 'self', 'window', 'document', 'process', 'require'])];

/** Static checks on top of the compiler (API misuse, sandbox-blocked globals). */
export function lintFile(file: StrategyFile, entry: boolean): Diagnostic[] {
  const out: Diagnostic[] = [];
  const code = codeOnly(file.source);
  const warn = (index: number, message: string, severity: Diagnostic['severity'] = 'warning') =>
    out.push({ file: file.name, ...lineCol(file.source, index), message, severity });
  for (const name of RISKY) {
    const re = new RegExp(`(?<![\\w.$])${name}\\b`, 'g');
    for (const m of code.matchAll(re))
      warn(m.index, `'${name}' is not available in the HT Strategy sandbox (no DOM, no network)`);
  }
  for (const m of file.source.matchAll(/\bindicator\(\s*['"]([\w-]+)['"]/g))
    if (code.slice(m.index, m.index + 9) === 'indicator' && !indicatorById(m[1]!))
      warn(m.index, `Unknown indicator '${m[1]}'`);
  if (entry && !/export\s+(async\s+)?function\s+(onBar|onTick)\b|export\s+const\s+(onBar|onTick)\b/.test(code))
    warn(0, 'The strategy file must export onBar(bar) or onTick(tick)', 'error');
  if (/\bexport\s+async\s+function\b/.test(code))
    warn(code.search(/\bexport\s+async\s+function\b/), 'Hooks run synchronously: async hooks are not awaited');
  return out;
}

/**
 * Compiles a strategy project: TypeScript-like syntax is stripped and ES module syntax turned
 * into the sandbox's CommonJS form by Sucrase (line numbers are preserved, so runtime errors map
 * back to the editor). The first file is the entry.
 */
export function compileProject(files: StrategyFile[]): CompileOutput {
  const diagnostics: Diagnostic[] = [];
  const modules: CompiledProject['modules'] = [];
  files.forEach((f, i) => {
    diagnostics.push(...lintFile(f, i === 0));
    try {
      const code = transform(f.source, {
        transforms: ['typescript', 'imports'],
        filePath: f.name,
        production: true,
      }).code;
      const bad = forbiddenSyntax(code);
      if (bad) diagnostics.push({ file: f.name, line: 1, column: 0, message: bad, severity: 'error' });
      else modules.push({ name: f.name, code });
    } catch (e) {
      const loc = (e as { loc?: { line: number; column: number } }).loc;
      const msg = e instanceof Error ? e.message.replace(/\s*\(\d+:\d+\)$/, '') : String(e);
      diagnostics.push({
        file: f.name,
        line: loc?.line ?? 1,
        column: loc?.column ?? 0,
        message: `Syntax error: ${msg}`,
        severity: 'error',
      });
    }
  });
  const ok = files.length > 0 && !diagnostics.some((d) => d.severity === 'error');
  return { project: ok ? { entry: files[0]!.name, modules } : null, diagnostics };
}
