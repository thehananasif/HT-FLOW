/** `.htstrat` files: an HT Editor strategy project (sources + parameter values) as JSON. */

export interface StrategyFile {
  name: string;
  source: string;
}

export interface StrategyProject {
  id: string;
  name: string;
  /** First file is the entry (the strategy); others can be imported with `./name`. */
  files: StrategyFile[];
  /** Saved parameter values. */
  params: Record<string, number | boolean | string>;
  createdAt: number;
  updatedAt: number;
}

export const HTSTRAT_FORMAT = 'htstrat';
export const HTSTRAT_VERSION = 1;
const MAX_FILES = 16;
const MAX_SOURCE = 256 * 1024;
const FILE_NAME = /^[\w-]{1,40}\.(ts|js)$/;

export function serializeHtstrat(p: StrategyProject): string {
  return JSON.stringify(
    {
      format: HTSTRAT_FORMAT,
      version: HTSTRAT_VERSION,
      id: p.id,
      name: p.name,
      files: p.files,
      params: p.params,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    },
    null,
    2,
  );
}

export function validFileName(name: string): boolean {
  return FILE_NAME.test(name);
}

/** Normalises an untrusted project (file import, settings load). Throws a readable error. */
export function normalizeProject(raw: unknown, now = Date.now()): StrategyProject {
  if (!raw || typeof raw !== 'object') throw new Error('Not a strategy project');
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.files) || !r.files.length) throw new Error('The project has no files');
  if (r.files.length > MAX_FILES) throw new Error(`At most ${MAX_FILES} files per strategy`);
  const seen = new Set<string>();
  const files: StrategyFile[] = r.files.map((f: unknown) => {
    const x = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>;
    const name = typeof x.name === 'string' ? x.name : '';
    if (!validFileName(name)) throw new Error(`Invalid file name '${name.slice(0, 40)}'`);
    if (seen.has(name)) throw new Error(`Duplicate file '${name}'`);
    seen.add(name);
    if (typeof x.source !== 'string') throw new Error(`File '${name}' has no source`);
    if (x.source.length > MAX_SOURCE) throw new Error(`File '${name}' is larger than 256 KB`);
    return { name, source: x.source };
  });
  const params: StrategyProject['params'] = {};
  if (r.params && typeof r.params === 'object')
    for (const [k, v] of Object.entries(r.params as Record<string, unknown>))
      if (
        /^\w{1,40}$/.test(k) &&
        ((typeof v === 'number' && Number.isFinite(v)) ||
          typeof v === 'boolean' ||
          (typeof v === 'string' && v.length <= 256))
      )
        params[k] = v as number | boolean | string;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : now);
  return {
    id:
      typeof r.id === 'string' && /^[\w-]{1,64}$/.test(r.id)
        ? r.id
        : `stg-${now.toString(36)}`,
    name: typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 80) : 'Strategy',
    files,
    params,
    createdAt: num(r.createdAt),
    updatedAt: num(r.updatedAt),
  };
}

export function parseHtstrat(text: string, now = Date.now()): StrategyProject {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Not a valid .htstrat file (bad JSON)');
  }
  const r = raw as Record<string, unknown>;
  if (r?.format !== HTSTRAT_FORMAT) throw new Error('Not a .htstrat file');
  if (typeof r.version !== 'number' || r.version > HTSTRAT_VERSION)
    throw new Error('This .htstrat file needs a newer HT Flow');
  return normalizeProject(raw, now);
}
