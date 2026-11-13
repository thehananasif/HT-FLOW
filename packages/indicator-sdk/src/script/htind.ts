/**
 * `.htind` files: a user indicator script plus a little metadata, as JSON.
 *
 *   { "format": "htind", "version": 1, "id": "my-osc", "name": "My oscillator",
 *     "source": "indicator(\"My oscillator\")\nplot(\"Close\", close)", "updated": 1700000000000 }
 *
 * Plain script text (no JSON) is accepted on import too.
 */
import { checkScript } from './compile';

export interface HtindFile {
  format: 'htind';
  version: 1;
  /** Stable slug; the indicator id on charts is `script:<id>`. */
  id: string;
  name: string;
  source: string;
  updated: number;
}

export const SCRIPT_PREFIX = 'script:';

export const slugId = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'script';

export function serializeHtind(f: HtindFile): string {
  return `${JSON.stringify(f, null, 2)}\n`;
}

/** Parses a `.htind` file (JSON or plain script text). Throws with a readable message. */
export function parseHtind(text: string, fallbackName = 'Script'): HtindFile {
  const t = text.replace(/^\uFEFF/, '').trim();
  let source: string;
  let name: string | null = null;
  let id: string | null = null;
  let updated = Date.now();
  if (t.startsWith('{')) {
    let raw: unknown;
    try {
      raw = JSON.parse(t);
    } catch {
      throw new Error('Not a valid .htind file (bad JSON)');
    }
    const o = raw as Partial<HtindFile>;
    if (o.format !== 'htind') throw new Error('Not an .htind file (format field missing)');
    if (typeof o.source !== 'string') throw new Error('The file has no script source');
    source = o.source;
    if (typeof o.name === 'string') name = o.name.slice(0, 60);
    if (typeof o.id === 'string') id = slugId(o.id);
    if (typeof o.updated === 'number' && Number.isFinite(o.updated)) updated = o.updated;
  } else source = text;
  const r = checkScript(source);
  if (!r.ok) throw new Error(`Script error: ${r.error}`);
  const nm = name ?? r.program.meta.name ?? fallbackName;
  return { format: 'htind', version: 1, id: id ?? slugId(nm), name: nm, source, updated };
}

/** Example shown in a new editor and used by the "Custom script" catalog entry. */
export const SAMPLE_SCRIPT = `// HT Script — an indicator in a few lines. Prices are real prices; x[1] is the previous bar.
indicator("Delta momentum", short="DMOM", pane="new")
len = input.int("Length", 14, min=1, max=500)
src = input.source("Source", "delta")
fast = ema(src, len)
slow = sma(src, len * 2)
plot.histogram("Fast - slow", fast - slow, color="#20C77A", color2="#F04A5D")
plot.line("Fast", fast, color="#4FA3F7")
plot.marker("Cross up", crossover(fast, slow), 0, shape="triangleUp", color="#20C77A")
hline(0)
`;
