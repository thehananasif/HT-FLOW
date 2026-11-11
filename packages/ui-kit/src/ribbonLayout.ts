/** Persisted ribbon layout: per-button visibility and order. Pure helpers. */
export interface RibbonLayout {
  hidden: string[];
  /** Explicit order of ids; ids not listed keep their default position after listed ones. */
  order: string[];
}

export const EMPTY_RIBBON: RibbonLayout = { hidden: [], order: [] };

export function sanitizeRibbon(raw: unknown, known: readonly string[]): RibbonLayout {
  if (!raw || typeof raw !== 'object') return { hidden: [], order: [] };
  const r = raw as Partial<RibbonLayout>;
  const set = new Set(known);
  const strs = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && set.has(x)) : [];
  return { hidden: [...new Set(strs(r.hidden))], order: [...new Set(strs(r.order))] };
}

/** Applies a saved order to the default id list (unlisted ids keep relative order at the end). */
export function applyOrder(defaults: readonly string[], order: readonly string[]): string[] {
  const inDefaults = new Set(defaults);
  const listed = order.filter((id) => inDefaults.has(id));
  const rest = defaults.filter((id) => !listed.includes(id));
  return [...listed, ...rest];
}

export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length)
    return [...list];
  const next = [...list];
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x!);
  return next;
}
