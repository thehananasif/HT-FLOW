import type {
  Aggressor,
  BookDelta,
  EventBatch,
  Instrument,
  Level,
  Trade,
} from '@htflow/market-data';
import { isNumeric, parseDateText, parseTime } from '../data-manager/import/time';

/**
 * Custom WebSocket connector (P05): pure mapping of JSON messages to trades and book updates, the
 * subscribe-message template and the config validation. The feed itself lives in feeds/customWs.ts.
 */

export interface WsMapping {
  /** Only messages where `when.path` equals `when.equals` are mapped (e.g. {"path":"e","equals":"trade"}). */
  when?: { path: string; equals: string };
  /** Path of the trade object, or of an array of trade objects; empty = the message itself. */
  tradesPath?: string;
  /** Paths below each trade object (or the message when `tradesPath` is empty). */
  price: string;
  qty: string;
  side?: string;
  timestamp?: string;
  /** 'text' = buy / sell words or +1 / -1; 'buyerMaker' = true means the seller was the aggressor. */
  sideMode?: 'text' | 'buyerMaker';
  /** Optional book: paths of arrays of [price, qty] pairs or {price, qty} objects. */
  bids?: string;
  asks?: string;
  /** 'snapshot' replaces the book, 'delta' sets levels (qty 0 removes). Default snapshot. */
  bookMode?: 'snapshot' | 'delta';
}

export interface CustomWsConfig {
  url: string;
  /** JSON text sent after connect; `{symbol}` is replaced by `symbol`. */
  subscribe?: string;
  symbol: string;
  tickSize: number;
  pricePrecision: number;
  qtyPrecision: number;
  mapping: WsMapping;
}

export const SAMPLE_MAPPING: WsMapping = {
  when: { path: 'e', equals: 'trade' },
  price: 'p',
  qty: 'q',
  side: 'm',
  sideMode: 'buyerMaker',
  timestamp: 'T',
};

export const DEFAULT_WS_CONFIG: CustomWsConfig = {
  url: 'wss://',
  subscribe: '{"method":"SUBSCRIBE","params":["{symbol}@trade"],"id":1}',
  symbol: 'BTCUSDT',
  tickSize: 0.01,
  pricePrecision: 2,
  qtyPrecision: 3,
  mapping: SAMPLE_MAPPING,
};

// ------------------------------------------------------------------ paths

type PathPart = string | number;

/** `a.b[0].c`, `a.b.0.c` and `["a"]` style paths. Empty / `$` = root. */
export function parsePath(path: string): PathPart[] | null {
  const p = path.trim().replace(/^\$\.?/, '');
  if (!p) return [];
  const parts: PathPart[] = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(p))) {
    parts.push(m[2] !== undefined ? Number(m[2]) : /^\d+$/.test(m[1]!) ? Number(m[1]) : m[1]!);
    consumed += m[0].length;
  }
  const separators = (p.match(/\./g) ?? []).length;
  return consumed + separators >= p.length - 0 ? parts : null;
}

export function getPath(obj: unknown, path: string): unknown {
  const parts = parsePath(path);
  if (!parts) return undefined;
  let cur: unknown = obj;
  for (const k of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return cur;
}

// ------------------------------------------------------------------ validation

export function validateMapping(m: unknown): string | null {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return 'Mapping must be a JSON object';
  const x = m as Partial<WsMapping>;
  const hasTrades = typeof x.price === 'string' && x.price.trim() !== '';
  const hasBook = typeof x.bids === 'string' || typeof x.asks === 'string';
  if (!hasTrades && !hasBook)
    return 'Map "price" and "qty" (trades) and / or "bids" / "asks" (book)';
  if (hasTrades && (typeof x.qty !== 'string' || !x.qty.trim()))
    return 'Mapping needs a "qty" path';
  for (const k of ['price', 'qty', 'side', 'timestamp', 'bids', 'asks', 'tradesPath'] as const) {
    const v = x[k];
    if (v !== undefined && (typeof v !== 'string' || parsePath(v) === null))
      return `"${k}" is not a valid path`;
  }
  if (x.when !== undefined) {
    if (
      typeof x.when.path !== 'string' ||
      parsePath(x.when.path) === null ||
      typeof x.when.equals !== 'string'
    )
      return '"when" needs a string "path" and "equals"';
  }
  if (x.sideMode !== undefined && x.sideMode !== 'text' && x.sideMode !== 'buyerMaker')
    return '"sideMode" is "text" or "buyerMaker"';
  if (x.bookMode !== undefined && x.bookMode !== 'snapshot' && x.bookMode !== 'delta')
    return '"bookMode" is "snapshot" or "delta"';
  return null;
}

/** Parses the mapping textarea. */
export function parseMappingText(text: string): { mapping?: WsMapping; error?: string } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return { error: `Mapping is not valid JSON: ${(e as Error).message}` };
  }
  const err = validateMapping(v);
  return err ? { error: err } : { mapping: v as WsMapping };
}

/** `{symbol}` substituted; the result must be valid JSON. */
export function renderSubscribe(
  template: string,
  symbol: string,
): { text?: string; error?: string } {
  const t = template.trim();
  if (!t) return { text: undefined };
  const text = t.split('{symbol}').join(symbol);
  try {
    JSON.parse(text);
  } catch (e) {
    return { error: `Subscribe message is not valid JSON: ${(e as Error).message}` };
  }
  return { text };
}

/** Field errors of the wizard form (empty object = valid). */
export function validateWsConfig(
  c: CustomWsConfig & { mappingText?: string },
): Record<string, string> {
  const e: Record<string, string> = {};
  let u: URL | null = null;
  try {
    u = new URL(c.url.trim());
  } catch {
    u = null;
  }
  if (!u || (u.protocol !== 'ws:' && u.protocol !== 'wss:')) e.url = 'Enter a ws:// or wss:// URL';
  else if (!u.hostname) e.url = 'The URL has no host';
  if (!c.symbol.trim()) e.symbol = 'Symbol is required';
  else if (!/^[A-Za-z0-9._-]{1,40}$/.test(c.symbol.trim()))
    e.symbol = 'Letters, digits, . _ - only';
  if (!(c.tickSize > 0)) e.tickSize = 'Must be greater than 0';
  if (c.subscribe?.trim()) {
    const r = renderSubscribe(c.subscribe, c.symbol || 'SYMBOL');
    if (r.error) e.subscribe = r.error;
  }
  const m = validateMapping(c.mapping);
  if (m) e.mapping = m;
  return e;
}

// ------------------------------------------------------------------ message mapping

function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return Number.NaN;
}

const BUY = new Set(['buy', 'b', 'bid', 'long', '1', '+1', 'buyer']);
const SELL = new Set(['sell', 's', 'ask', 'short', '-1', 'seller']);

export function mapSide(v: unknown, mode: 'text' | 'buyerMaker' = 'text'): Aggressor {
  if (v === undefined || v === null) return 'unknown';
  if (mode === 'buyerMaker') {
    if (v === true || v === 'true' || v === 1 || v === '1') return 'sell';
    if (v === false || v === 'false' || v === 0 || v === '0') return 'buy';
    return 'unknown';
  }
  if (typeof v === 'number') return v > 0 ? 'buy' : v < 0 ? 'sell' : 'unknown';
  if (typeof v === 'boolean') return v ? 'buy' : 'sell';
  const t = String(v).trim().toLowerCase();
  return BUY.has(t) ? 'buy' : SELL.has(t) ? 'sell' : 'unknown';
}

/** Message time in epoch ms: numbers by magnitude (s / ms / us / ns), ISO text, else `fallback`. */
export function mapTimestamp(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0)
    return parseTime(String(v), 'auto') ?? fallback;
  if (typeof v === 'string') {
    if (isNumeric(v)) return parseTime(v, 'auto') ?? fallback;
    return parseDateText(v, 'utc') ?? fallback;
  }
  return fallback;
}

function levels(raw: unknown, tickSize: number): Level[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Level[] = [];
  for (const r of raw) {
    let p = Number.NaN;
    let q = Number.NaN;
    if (Array.isArray(r)) {
      p = num(r[0]);
      q = num(r[1]);
    } else if (r && typeof r === 'object') {
      const o = r as Record<string, unknown>;
      p = num(o.price ?? o.p ?? o.px ?? o.rate);
      q = num(o.qty ?? o.size ?? o.q ?? o.amount ?? o.quantity);
    }
    if (Number.isFinite(p) && Number.isFinite(q) && p > 0 && q >= 0)
      out.push([Math.round(p / tickSize), q]);
  }
  return out;
}

/**
 * Maps one decoded message to an event batch (trades and / or book), or null when the message does
 * not match (acks, heartbeats, other channels). `idStart` numbers the trades.
 */
export function mapMessage(
  msg: unknown,
  cfg: Pick<CustomWsConfig, 'tickSize' | 'mapping'>,
  now: number,
  idStart = 0,
): EventBatch | null {
  const m = cfg.mapping;
  if (m.when && String(getPath(msg, m.when.path)) !== m.when.equals) return null;
  const trades: Trade[] = [];
  if (m.price) {
    const root = m.tradesPath ? getPath(msg, m.tradesPath) : msg;
    const items = Array.isArray(root) ? root : root && typeof root === 'object' ? [root] : [];
    for (const it of items) {
      const price = num(getPath(it, m.price));
      const qty = num(getPath(it, m.qty));
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty <= 0) continue;
      trades.push({
        ts: m.timestamp ? mapTimestamp(getPath(it, m.timestamp), now) : now,
        px: Math.round(price / cfg.tickSize),
        qty,
        side: m.side ? mapSide(getPath(it, m.side), m.sideMode) : 'unknown',
        id: idStart + trades.length + 1,
      });
    }
  }
  let snapshot: EventBatch['snapshot'];
  const deltas: BookDelta[] = [];
  const bids = m.bids ? levels(getPath(msg, m.bids), cfg.tickSize) : null;
  const asks = m.asks ? levels(getPath(msg, m.asks), cfg.tickSize) : null;
  if (bids || asks) {
    if (m.bookMode === 'delta') {
      for (const [px, qty] of bids ?? []) deltas.push({ side: 'buy', px, qty });
      for (const [px, qty] of asks ?? []) deltas.push({ side: 'sell', px, qty });
    } else {
      snapshot = {
        ts: now,
        bids: (bids ?? []).filter((l) => l[1] > 0).sort((a, b) => b[0] - a[0]),
        asks: (asks ?? []).filter((l) => l[1] > 0).sort((a, b) => a[0] - b[0]),
      };
    }
  }
  if (!trades.length && !snapshot && !deltas.length) return null;
  for (const t of trades) if (t.ts > now + 60_000) t.ts = now;
  return { ts: trades.at(-1)?.ts ?? now, trades, deltas, ...(snapshot ? { snapshot } : {}) };
}

/** Decodes a raw frame (text) and maps it; invalid JSON is not an error, just ignored. */
export function mapFrame(
  raw: string,
  cfg: Pick<CustomWsConfig, 'tickSize' | 'mapping'>,
  now: number,
  idStart = 0,
): EventBatch | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  return mapMessage(msg, cfg, now, idStart);
}

export function instrumentOf(connectionId: string, c: CustomWsConfig): Instrument {
  return {
    id: `custom-ws:${connectionId}:${c.symbol}`,
    symbol: c.symbol,
    displayName: `${c.symbol} (custom feed)`,
    exchange: 'Custom WebSocket',
    assetClass: 'crypto',
    tickSize: c.tickSize,
    pricePrecision: c.pricePrecision,
    qtyPrecision: c.qtyPrecision,
    tickValue: 0,
    currency: 'USD',
  };
}
