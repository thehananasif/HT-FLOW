import type { Aggressor, Trade } from '@htflow/market-data';
import {
  detectTimeFormat,
  isNumeric,
  parseTime,
  type DateOrder,
  type TimeFormat,
  type TimeZoneSpec,
} from './time';

/**
 * CSV importer core (P05 / P06): an incremental RFC 4180 parser (quoted fields, embedded newlines,
 * CRLF), delimiter / header / column / time-format detection, row validation with line numbers and a
 * chunked importer that never holds the whole file as one string. Pure and DOM-free (tested).
 */

// ------------------------------------------------------------------ parser

export interface CsvRecord {
  /** 1-based physical line the record starts on. */
  line: number;
  cells: string[];
}

/** Incremental parser: feed text chunks of any size; records are returned as soon as they complete. */
export class CsvParser {
  private field = '';
  private cells: string[] = [];
  private inQuotes = false;
  private quotePending = false;
  private fieldStart = true;
  private line = 1;
  private recordLine = 1;

  constructor(private delimiter: string) {}

  push(text: string): CsvRecord[] {
    const out: CsvRecord[] = [];
    const d = this.delimiter;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (this.inQuotes) {
        if (this.quotePending) {
          this.quotePending = false;
          if (ch === '"') {
            this.field += '"';
            continue;
          }
          this.inQuotes = false;
        } else {
          if (ch === '"') this.quotePending = true;
          else {
            if (ch === '\n') this.line++;
            this.field += ch;
          }
          continue;
        }
      }
      if (ch === '"' && this.fieldStart) {
        this.inQuotes = true;
        this.fieldStart = false;
      } else if (ch === d) {
        this.cells.push(this.field);
        this.field = '';
        this.fieldStart = true;
      } else if (ch === '\n') {
        this.endRecord(out);
        this.line++;
        this.recordLine = this.line;
      } else if (ch !== '\r') {
        this.field += ch;
        this.fieldStart = false;
      }
    }
    return out;
  }

  /** Flushes a last record that has no trailing newline. */
  end(): CsvRecord[] {
    const out: CsvRecord[] = [];
    if (this.field !== '' || this.cells.length) this.endRecord(out);
    return out;
  }

  private endRecord(out: CsvRecord[]): void {
    this.cells.push(this.field);
    const blank = this.cells.length === 1 && this.cells[0]!.trim() === '';
    if (!blank) out.push({ line: this.recordLine, cells: this.cells });
    this.cells = [];
    this.field = '';
    this.fieldStart = true;
    this.inQuotes = false;
    this.quotePending = false;
  }
}

/** Parses a whole (small) text; used for previews and tests. */
export function parseCsvText(text: string, delimiter: string): CsvRecord[] {
  const p = new CsvParser(delimiter);
  return [...p.push(text), ...p.end()];
}

export const DELIMITERS = [',', ';', '\t', '|'] as const;

/** Picks the delimiter that gives the most consistent column count (> 1) over the sample. */
export function detectDelimiter(sample: string): string {
  let best = ',';
  let bestScore = 0;
  for (const d of DELIMITERS) {
    const rows = parseCsvText(sample, d).slice(0, 50);
    if (!rows.length) continue;
    const counts = new Map<number, number>();
    for (const r of rows) counts.set(r.cells.length, (counts.get(r.cells.length) ?? 0) + 1);
    let mode = 1;
    let modeN = 0;
    for (const [c, n] of counts) {
      if (n > modeN || (n === modeN && c > mode)) {
        mode = c;
        modeN = n;
      }
    }
    if (mode < 2) continue;
    const score = modeN * 1000 + mode;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

// ------------------------------------------------------------------ mapping

export type CsvKind = 'trades' | 'bars';
export type SideMode = 'text' | 'buyerMaker';

/** Column index per field, -1 = not mapped. */
export interface CsvMapping {
  kind: CsvKind;
  time: number;
  price: number;
  qty: number;
  side: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CsvOptions {
  delimiter: string;
  hasHeader: boolean;
  timeFormat: TimeFormat;
  timeZone: TimeZoneSpec;
  dateOrder: DateOrder;
  sideMode: SideMode;
  /** Bar length in ms for OHLCV import; 0 = infer from the data. */
  barMs: number;
}

export const DEFAULT_OPTIONS: CsvOptions = {
  delimiter: ',',
  hasHeader: true,
  timeFormat: 'auto',
  timeZone: 'utc',
  dateOrder: 'ymd',
  sideMode: 'text',
  barMs: 0,
};

export const EMPTY_MAPPING: CsvMapping = {
  kind: 'trades',
  time: -1,
  price: -1,
  qty: -1,
  side: -1,
  open: -1,
  high: -1,
  low: -1,
  close: -1,
  volume: -1,
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const ALIASES: Record<keyof Omit<CsvMapping, 'kind'>, string[]> = {
  time: [
    'time',
    'timestamp',
    'ts',
    'datetime',
    'date',
    'dateutc',
    'timeutc',
    'opentime',
    'transacttime',
    'tradetime',
    'eventtime',
    't',
    'timems',
  ],
  price: ['price', 'px', 'p', 'last', 'lastprice', 'tradeprice', 'rate'],
  qty: ['qty', 'quantity', 'size', 'amount', 'q', 'lastqty', 'tradesize', 'baseqty'],
  side: [
    'side',
    'takerside',
    'aggressor',
    'direction',
    'isbuyermaker',
    'buyermaker',
    'ismaker',
    'initiator',
  ],
  open: ['open', 'o', 'openprice'],
  high: ['high', 'h', 'highprice'],
  low: ['low', 'l', 'lowprice'],
  close: ['close', 'c', 'closeprice', 'last'],
  volume: ['volume', 'vol', 'v', 'basevolume', 'qty', 'size'],
};

export interface Detected {
  options: CsvOptions;
  mapping: CsvMapping;
  headers: string[];
}

/** True when the first record looks like column names rather than data. */
export function looksLikeHeader(first: string[]): boolean {
  const cells = first.map((c) => c.trim()).filter(Boolean);
  if (!cells.length) return false;
  return !cells.some((c) => isNumeric(c) || /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(c));
}

/** Auto-detects delimiter, header, columns, kind and time format from a text sample. */
export function autoDetect(sample: string): Detected {
  const delimiter = detectDelimiter(sample);
  const recs = parseCsvText(sample, delimiter);
  const first = recs[0]?.cells ?? [];
  const hasHeader = looksLikeHeader(first);
  const data = recs.slice(hasHeader ? 1 : 0, 200);
  const width = Math.max(first.length, ...data.map((r) => r.cells.length), 0);
  const headers = hasHeader
    ? first.map((h) => h.trim())
    : Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
  const m: CsvMapping = { ...EMPTY_MAPPING };
  if (hasHeader) {
    const idx = (key: keyof Omit<CsvMapping, 'kind'>, taken: Set<number>) =>
      headers.findIndex((h, i) => !taken.has(i) && ALIASES[key].includes(norm(h)));
    const taken = new Set<number>();
    const claim = (key: keyof Omit<CsvMapping, 'kind'>) => {
      const i = idx(key, taken);
      if (i >= 0) taken.add(i);
      m[key] = i;
    };
    claim('time');
    for (const k of ['open', 'high', 'low', 'close'] as const) claim(k);
    const bars = m.open >= 0 && m.high >= 0 && m.low >= 0 && m.close >= 0;
    if (bars) {
      m.kind = 'bars';
      claim('volume');
    } else {
      claim('price');
      if (m.price < 0 && m.close >= 0) {
        m.price = m.close;
        m.close = -1;
      }
      claim('qty');
      claim('side');
    }
  } else if (width >= 5 && data.slice(0, 5).every((r) => r.cells.slice(1, 5).every(isNumeric))) {
    Object.assign(m, { kind: 'bars', time: 0, open: 1, high: 2, low: 3, close: 4 });
    if (width >= 6) m.volume = 5;
  } else {
    Object.assign(m, { kind: 'trades', time: 0, price: 1, qty: 2 });
    if (width >= 4) m.side = 3;
  }
  const timeCol = m.time >= 0 ? m.time : 0;
  const timeFormat = detectTimeFormat(data.slice(0, 50).map((r) => r.cells[timeCol] ?? ''));
  const sideHeader = m.side >= 0 ? norm(headers[m.side] ?? '') : '';
  return {
    headers,
    mapping: m,
    options: {
      ...DEFAULT_OPTIONS,
      delimiter,
      hasHeader,
      timeFormat,
      sideMode: /buyermaker|ismaker/.test(sideHeader) ? 'buyerMaker' : 'text',
    },
  };
}

// ------------------------------------------------------------------ rows

const BUY = new Set(['buy', 'b', 'bid', 'long', 'buyer', '1', '+1', 'true', 'ask_hit', 'up']);
const SELL = new Set([
  'sell',
  's',
  'ask',
  'short',
  'seller',
  '-1',
  '2',
  'false',
  'bid_hit',
  'down',
]);

/** +1 buy, -1 sell, 0 unknown/empty, null = unrecognised token. */
export function parseSide(raw: string, mode: SideMode): -1 | 0 | 1 | null {
  const t = raw.trim().toLowerCase();
  if (!t) return 0;
  if (mode === 'buyerMaker') {
    // is_buyer_maker = true means the seller was the aggressor.
    if (t === 'true' || t === '1') return -1;
    if (t === 'false' || t === '0') return 1;
    return null;
  }
  if (BUY.has(t)) return 1;
  if (SELL.has(t)) return -1;
  return null;
}

function decimalsOf(text: string): number {
  const t = text.trim();
  const e = /e-(\d+)$/i.exec(t);
  const dot = t.indexOf('.');
  const base = dot < 0 ? 0 : t.replace(/e.*$/i, '').length - dot - 1;
  return Math.min(8, base + (e ? Number(e[1]) : 0));
}

function num(raw: string | undefined): number {
  if (raw === undefined) return Number.NaN;
  const t = raw.trim().replace(/^"|"$/g, '');
  if (!t) return Number.NaN;
  return Number(t);
}

export interface CsvIssue {
  line: number;
  message: string;
}

export interface ImportResult {
  kind: CsvKind;
  /** Trades in time order; px is in ticks of `tickSize`. */
  trades: Trade[];
  tickSize: number;
  pricePrecision: number;
  qtyPrecision: number;
  /** Source rows accepted / rejected. */
  rows: number;
  errorCount: number;
  /** First rejected rows (capped). */
  errors: CsvIssue[];
  /** The file was not in time order and has been sorted. */
  sorted: boolean;
  /** Side was missing and is derived with the tick rule. */
  sideDerived: boolean;
  from: number;
  to: number;
  /** Bar length used to place synthetic trades (bars only). */
  barMs: number;
}

export const MAX_STORED_ISSUES = 200;
export const DEFAULT_MAX_ROWS = 10_000_000;

/** Validation of one data record; shared by the preview and the importer. */
export type RowResult =
  | { ok: true; ts: number; a: number; b: number; c: number; d: number; e: number; dec: number }
  | { ok: false; message: string };

/**
 * Converts one record. Trades: a = price, b = qty, c = side. Bars: a/b/c/d = open/high/low/close,
 * e = volume (NaN when not mapped).
 */
export function convertRow(cells: string[], m: CsvMapping, o: CsvOptions): RowResult {
  const cell = (i: number) => (i >= 0 ? cells[i] : undefined);
  if (m.time < 0) return { ok: false, message: 'No time column is mapped' };
  const tRaw = cell(m.time);
  if (tRaw === undefined) return { ok: false, message: `Missing column ${m.time + 1} (time)` };
  const ts = parseTime(tRaw, o.timeFormat, o.timeZone, o.dateOrder);
  if (ts === null) return { ok: false, message: `Bad time "${clip(tRaw)}"` };
  if (m.kind === 'trades') {
    if (m.price < 0 || m.qty < 0)
      return { ok: false, message: 'Price and quantity must be mapped' };
    const pRaw = cell(m.price);
    const qRaw = cell(m.qty);
    if (pRaw === undefined || qRaw === undefined) return { ok: false, message: 'Row is too short' };
    const price = num(pRaw);
    const qty = num(qRaw);
    if (!Number.isFinite(price) || price <= 0)
      return { ok: false, message: `Bad price "${clip(pRaw)}"` };
    if (!Number.isFinite(qty) || qty <= 0)
      return { ok: false, message: `Bad quantity "${clip(qRaw)}"` };
    let side: -1 | 0 | 1 = 0;
    if (m.side >= 0) {
      const sRaw = cell(m.side) ?? '';
      const s = parseSide(sRaw, o.sideMode);
      if (s === null) return { ok: false, message: `Unrecognised side "${clip(sRaw)}"` };
      side = s;
    }
    return { ok: true, ts, a: price, b: qty, c: side, d: 0, e: 0, dec: decimalsOf(pRaw) };
  }
  if (m.open < 0 || m.high < 0 || m.low < 0 || m.close < 0)
    return { ok: false, message: 'Open, high, low and close must be mapped' };
  const raws = [cell(m.open), cell(m.high), cell(m.low), cell(m.close)];
  if (raws.some((r) => r === undefined)) return { ok: false, message: 'Row is too short' };
  const [op, hi, lo, cl] = raws.map(num) as [number, number, number, number];
  for (const [name, v, r] of [
    ['open', op, raws[0]],
    ['high', hi, raws[1]],
    ['low', lo, raws[2]],
    ['close', cl, raws[3]],
  ] as const)
    if (!Number.isFinite(v) || v <= 0)
      return { ok: false, message: `Bad ${name} "${clip(r ?? '')}"` };
  if (hi < lo) return { ok: false, message: 'High is below low' };
  if (op > hi || op < lo || cl > hi || cl < lo)
    return { ok: false, message: 'Open / close outside the high-low range' };
  const vol = m.volume >= 0 ? num(cell(m.volume)) : Number.NaN;
  if (m.volume >= 0 && cell(m.volume)?.trim() && (!Number.isFinite(vol) || vol < 0))
    return { ok: false, message: `Bad volume "${clip(cell(m.volume) ?? '')}"` };
  const dec = Math.max(...raws.map((r) => decimalsOf(r ?? '')));
  return { ok: true, ts, a: op, b: hi, c: lo, d: cl, e: vol, dec };
}

const clip = (s: string) => (s.length > 24 ? `${s.slice(0, 24)}…` : s);

// ------------------------------------------------------------------ importer

/** Chunk-fed importer: `push(text)` per chunk, then `finish()`. */
export class CsvImporter {
  private parser: CsvParser;
  private seenFirst = false;
  private ts: number[] = [];
  private a: number[] = [];
  private b: number[] = [];
  private c: number[] = [];
  private d: number[] = [];
  private e: number[] = [];
  private maxDec = 0;
  private maxQtyDec = 0;
  private last = -Infinity;
  private ordered = true;
  private errors: CsvIssue[] = [];
  errorCount = 0;
  rows = 0;
  /** Records consumed so far (excluding the header). */
  records = 0;
  truncated = false;

  constructor(
    private mapping: CsvMapping,
    private options: CsvOptions,
    private maxRows = DEFAULT_MAX_ROWS,
  ) {
    this.parser = new CsvParser(options.delimiter);
  }

  push(text: string): void {
    this.consume(this.parser.push(text));
  }

  private consume(recs: CsvRecord[]): void {
    for (const r of recs) {
      if (!this.seenFirst) {
        this.seenFirst = true;
        if (this.options.hasHeader) continue;
      }
      this.records++;
      if (this.rows >= this.maxRows) {
        this.truncated = true;
        continue;
      }
      const res = convertRow(r.cells, this.mapping, this.options);
      if (!res.ok) {
        this.errorCount++;
        if (this.errors.length < MAX_STORED_ISSUES)
          this.errors.push({ line: r.line, message: res.message });
        continue;
      }
      this.rows++;
      if (res.ts < this.last) this.ordered = false;
      this.last = res.ts;
      this.ts.push(res.ts);
      this.a.push(res.a);
      this.b.push(res.b);
      this.c.push(res.c);
      if (this.mapping.kind === 'bars') {
        this.d.push(res.d);
        this.e.push(res.e);
      } else if (this.maxQtyDec < 8) {
        const q = r.cells[this.mapping.qty] ?? '';
        this.maxQtyDec = Math.max(this.maxQtyDec, decimalsOf(q));
      }
      if (res.dec > this.maxDec) this.maxDec = res.dec;
    }
  }

  finish(): ImportResult {
    this.consume(this.parser.end());
    const n = this.rows;
    const order = Array.from({ length: n }, (_, i) => i);
    if (!this.ordered) order.sort((x, y) => this.ts[x]! - this.ts[y]! || x - y);
    const kind = this.mapping.kind;
    const pricePrecision = Math.max(0, this.maxDec);
    const tickSize = Number((10 ** -pricePrecision).toFixed(pricePrecision));
    const toTick = (p: number) => Math.round(p / tickSize);
    const trades: Trade[] = [];
    let barMs = 0;
    let sideDerived = false;
    if (kind === 'trades') {
      sideDerived = this.mapping.side < 0;
      for (let k = 0; k < n; k++) {
        const i = order[k]!;
        trades.push({
          ts: this.ts[i]!,
          px: toTick(this.a[i]!),
          qty: this.b[i]!,
          side: sideOf(this.c[i]!),
          id: k + 1,
        });
      }
    } else {
      barMs =
        this.options.barMs > 0 ? this.options.barMs : inferBarMs(order.map((i) => this.ts[i]!));
      let id = 1;
      for (let k = 0; k < n; k++) {
        const i = order[k]!;
        const open = this.a[i]!;
        const hi = this.b[i]!;
        const lo = this.c[i]!;
        const close = this.d[i]!;
        const vol = this.e[i]!;
        const path = close >= open ? [open, lo, hi, close] : [open, hi, lo, close];
        const qty = Number.isFinite(vol) && vol > 0 ? vol / 4 : 1;
        const t0 = this.ts[i]!;
        for (let j = 0; j < 4; j++)
          trades.push({
            ts: t0 + Math.floor((barMs * 0.9 * j) / 3),
            px: toTick(path[j]!),
            qty,
            side: 'unknown',
            id: id++,
          });
      }
      this.maxQtyDec = Number.isFinite(this.e[0] ?? Number.NaN) ? 4 : 0;
      sideDerived = true;
    }
    if (sideDerived || trades.some((t) => t.side === 'unknown')) tickRule(trades);
    return {
      kind,
      trades,
      tickSize,
      pricePrecision,
      qtyPrecision: Math.min(8, this.maxQtyDec),
      rows: n,
      errorCount: this.errorCount,
      errors: this.errors,
      sorted: !this.ordered,
      sideDerived,
      from: trades[0]?.ts ?? 0,
      to: trades.at(-1)?.ts ?? 0,
      barMs,
    };
  }
}

const sideOf = (s: number): Aggressor => (s > 0 ? 'buy' : s < 0 ? 'sell' : 'unknown');

/** Median spacing of bar open times (ms), snapped to whole seconds; 60 s when unknown. */
export function inferBarMs(times: readonly number[]): number {
  const diffs: number[] = [];
  for (let i = 1; i < times.length && diffs.length < 1000; i++) {
    const d = times[i]! - times[i - 1]!;
    if (d > 0) diffs.push(d);
  }
  if (!diffs.length) return 60_000;
  diffs.sort((x, y) => x - y);
  const med = diffs[Math.floor(diffs.length / 2)]!;
  return Math.max(1000, Math.round(med / 1000) * 1000);
}

/** Tick rule: uptick = buy, downtick = sell, equal = previous side (first trade = buy). */
export function tickRule(trades: Trade[]): void {
  let prevPx = Number.NaN;
  let prev: Aggressor = 'buy';
  for (const t of trades) {
    if (t.side === 'unknown') {
      t.side = t.px > prevPx ? 'buy' : t.px < prevPx ? 'sell' : prev;
    }
    prevPx = t.px;
    prev = t.side;
  }
}

// ------------------------------------------------------------------ streaming

/** Anything we can read in chunks: a File / Blob, a ReadableStream of bytes, or async text chunks. */
export type ChunkSource = Blob | ReadableStream<Uint8Array> | AsyncIterable<string | Uint8Array>;

async function* textChunks(src: ChunkSource): AsyncGenerator<{ text: string; bytes: number }> {
  const dec = new TextDecoder('utf-8');
  const emit = (v: string | Uint8Array) =>
    typeof v === 'string'
      ? { text: v, bytes: v.length }
      : { text: dec.decode(v, { stream: true }), bytes: v.byteLength };
  if (typeof Blob !== 'undefined' && src instanceof Blob) {
    const reader = src.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield emit(value);
    }
  } else if ('getReader' in src) {
    const reader = (src as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield emit(value);
    }
  } else {
    for await (const v of src as AsyncIterable<string | Uint8Array>) yield emit(v);
  }
  const tail = dec.decode();
  if (tail) yield { text: tail, bytes: 0 };
}

export interface ImportProgress {
  bytes: number;
  rows: number;
  errors: number;
}

/**
 * Streams a file through the importer chunk by chunk (browser: `file.stream()`, 64 KB-ish chunks),
 * so the file text is never held in memory at once. Yields to the event loop between chunks.
 */
export async function importCsv(
  src: ChunkSource,
  mapping: CsvMapping,
  options: CsvOptions,
  opts: {
    onProgress?: (p: ImportProgress) => void;
    signal?: AbortSignal;
    maxRows?: number;
  } = {},
): Promise<ImportResult & { truncated: boolean }> {
  const imp = new CsvImporter(mapping, options, opts.maxRows);
  let bytes = 0;
  let lastTick = 0;
  for await (const chunk of textChunks(src)) {
    if (opts.signal?.aborted) throw new DOMException('Import cancelled', 'AbortError');
    imp.push(chunk.text);
    bytes += chunk.bytes;
    const now = Date.now();
    if (now - lastTick > 50) {
      lastTick = now;
      opts.onProgress?.({ bytes, rows: imp.rows, errors: imp.errorCount });
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  const res = imp.finish();
  opts.onProgress?.({ bytes, rows: res.rows, errors: res.errorCount });
  return { ...res, truncated: imp.truncated };
}

/** First ~256 KB of a file as text (complete lines only) for the preview / auto-detection. */
export async function readSample(file: Blob, maxBytes = 256 * 1024): Promise<string> {
  const text = await file.slice(0, maxBytes).text();
  if (file.size <= maxBytes) return text;
  const cut = text.lastIndexOf('\n');
  return cut > 0 ? text.slice(0, cut + 1) : text;
}
