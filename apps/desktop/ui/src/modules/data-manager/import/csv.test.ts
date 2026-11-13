import { describe, expect, it } from 'vitest';
import {
  CsvImporter,
  CsvParser,
  autoDetect,
  detectDelimiter,
  importCsv,
  parseCsvText,
  parseSide,
  DEFAULT_OPTIONS,
  type CsvMapping,
  type CsvOptions,
} from './csv';
import { detectTimeFormat, parseTime, parseTimeZone } from './time';

const TRADES = `timestamp,price,qty,side
2024-03-01T10:00:00Z,100.50,2,buy
2024-03-01T10:00:01.250Z,100.45,1.5,sell
2024-03-01T10:00:02Z,100.45,3,buy
`;

describe('CsvParser', () => {
  it('handles quotes, escaped quotes, embedded newlines and CRLF with line numbers', () => {
    const r = parseCsvText('a,"b,1","he said ""hi"""\r\n"x\ny",2,3\r\n\r\nlast,1,2', ',');
    expect(r.map((x) => x.cells)).toEqual([
      ['a', 'b,1', 'he said "hi"'],
      ['x\ny', '2', '3'],
      ['last', '1', '2'],
    ]);
    expect(r.map((x) => x.line)).toEqual([1, 2, 5]);
  });

  it('gives the same records for any chunking', () => {
    const text = 'a,"b\n1",c\n2,3,4\n"q""x",5,6\n';
    const whole = parseCsvText(text, ',');
    for (const size of [1, 2, 3, 7]) {
      const p = new CsvParser(',');
      const out = [];
      for (let i = 0; i < text.length; i += size) out.push(...p.push(text.slice(i, i + size)));
      out.push(...p.end());
      expect(out).toEqual(whole);
    }
  });
});

describe('detection', () => {
  it('detects delimiters', () => {
    expect(detectDelimiter('a;b;c\n1;2;3\n')).toBe(';');
    expect(detectDelimiter('a\tb\n1\t2\n')).toBe('\t');
    expect(detectDelimiter('a,b,c\n1,2,3\n')).toBe(',');
  });

  it('detects header, columns, side semantics and time format', () => {
    const d = autoDetect(TRADES);
    expect(d.options.hasHeader).toBe(true);
    expect(d.options.timeFormat).toBe('iso');
    expect(d.mapping).toMatchObject({ kind: 'trades', time: 0, price: 1, qty: 2, side: 3 });
    const bars = autoDetect('Open Time;Open;High;Low;Close;Volume\n1709287200000;1;2;0.5;1.5;10\n');
    expect(bars.mapping).toMatchObject({
      kind: 'bars',
      time: 0,
      open: 1,
      high: 2,
      low: 3,
      close: 4,
      volume: 5,
    });
    expect(bars.options.timeFormat).toBe('epoch-ms');
    expect(bars.options.delimiter).toBe(';');
    const bm = autoDetect('time,price,qty,is_buyer_maker\n1709287200,1,1,true\n');
    expect(bm.options.sideMode).toBe('buyerMaker');
    const none = autoDetect('1709287200,100.5,2\n1709287201,100.6,1\n');
    expect(none.options.hasHeader).toBe(false);
    expect(none.mapping).toMatchObject({ kind: 'trades', time: 0, price: 1, qty: 2, side: -1 });
  });
});

describe('time parsing', () => {
  it('parses epoch s / ms / us / ns and ISO', () => {
    const ms = Date.UTC(2024, 2, 1, 10, 0, 0);
    expect(parseTime('1709287200', 'auto')).toBe(ms);
    expect(parseTime('1709287200000', 'auto')).toBe(ms);
    expect(parseTime('1709287200000000', 'epoch-us')).toBe(ms);
    expect(parseTime('1709287200000000000', 'auto')).toBe(ms);
    expect(parseTime('1709287200.5', 'epoch-s')).toBe(ms + 500);
    expect(parseTime('2024-03-01T10:00:00Z', 'auto')).toBe(ms);
    expect(parseTime('2024-03-01 10:00:00.123', 'iso')).toBe(ms + 123);
    expect(parseTime('nope', 'auto')).toBeNull();
  });

  it('applies time zones only to text without an offset', () => {
    const utc = Date.UTC(2024, 2, 1, 10, 0, 0);
    expect(parseTime('2024-03-01 12:00:00', 'iso', 120)).toBe(utc);
    expect(parseTime('2024-03-01T10:00:00+02:00', 'iso', 'utc')).toBe(utc - 2 * 3600_000);
    expect(parseTime('01/03/2024 10:00', 'iso', 'utc', 'dmy')).toBe(utc);
    expect(parseTime('03/01/2024 10:00', 'iso', 'utc', 'mdy')).toBe(utc);
    expect(parseTimeZone('+05:30')).toBe(330);
    expect(parseTimeZone('UTC-8')).toBe(-480);
    expect(parseTimeZone('x')).toBeNull();
    expect(detectTimeFormat(['1709287200000', '1709287201000'])).toBe('epoch-ms');
  });

  it('parses sides', () => {
    expect(parseSide('B', 'text')).toBe(1);
    expect(parseSide('-1', 'text')).toBe(-1);
    expect(parseSide('', 'text')).toBe(0);
    expect(parseSide('maybe', 'text')).toBeNull();
    expect(parseSide('true', 'buyerMaker')).toBe(-1);
    expect(parseSide('false', 'buyerMaker')).toBe(1);
  });
});

const tradeMap: CsvMapping = {
  kind: 'trades',
  time: 0,
  price: 1,
  qty: 2,
  side: 3,
  open: -1,
  high: -1,
  low: -1,
  close: -1,
  volume: -1,
};
const opts: CsvOptions = { ...DEFAULT_OPTIONS, timeFormat: 'iso' };

describe('CsvImporter trades', () => {
  it('imports trades into ticks with side and precision', () => {
    const i = new CsvImporter(tradeMap, opts);
    i.push(TRADES);
    const r = i.finish();
    expect(r.rows).toBe(3);
    expect(r.errorCount).toBe(0);
    expect(r.pricePrecision).toBe(2);
    expect(r.tickSize).toBe(0.01);
    expect(r.trades.map((t) => [t.px, t.qty, t.side])).toEqual([
      [10050, 2, 'buy'],
      [10045, 1.5, 'sell'],
      [10045, 3, 'buy'],
    ]);
    expect(r.trades[1]!.ts).toBe(Date.UTC(2024, 2, 1, 10, 0, 1, 250));
    expect(r.qtyPrecision).toBe(1);
  });

  it('reports invalid rows with line numbers and keeps the valid ones', () => {
    const text = `time,price,qty,side
2024-03-01T10:00:00Z,100,1,buy
garbage,100,1,buy
2024-03-01T10:00:02Z,-5,1,buy
2024-03-01T10:00:03Z,100,0,sell
2024-03-01T10:00:04Z,100,1,sideways
2024-03-01T10:00:05Z,101,1,sell
`;
    const i = new CsvImporter(tradeMap, opts);
    i.push(text);
    const r = i.finish();
    expect(r.rows).toBe(2);
    expect(r.errorCount).toBe(4);
    expect(r.errors.map((e) => e.line)).toEqual([3, 4, 5, 6]);
    expect(r.errors[0]!.message).toMatch(/Bad time/);
    expect(r.errors[1]!.message).toMatch(/Bad price/);
    expect(r.errors[2]!.message).toMatch(/Bad quantity/);
    expect(r.errors[3]!.message).toMatch(/Unrecognised side/);
  });

  it('sorts out-of-order rows, derives side with the tick rule when unmapped', () => {
    const text = '1709287202000,101,1\n1709287200000,100,1\n1709287201000,100,2\n';
    const m = { ...tradeMap, side: -1 };
    const i = new CsvImporter(m, { ...DEFAULT_OPTIONS, hasHeader: false, timeFormat: 'epoch-ms' });
    i.push(text);
    const r = i.finish();
    expect(r.sorted).toBe(true);
    expect(r.sideDerived).toBe(true);
    expect(r.trades.map((t) => t.px)).toEqual([100, 100, 101]);
    expect(r.trades.map((t) => t.side)).toEqual(['buy', 'buy', 'buy']);
    expect(r.pricePrecision).toBe(0);
  });

  it('stops at maxRows', () => {
    const i = new CsvImporter(tradeMap, opts, 2);
    i.push(TRADES);
    const r = i.finish();
    expect(r.rows).toBe(2);
    expect(i.truncated).toBe(true);
  });
});

describe('CsvImporter bars', () => {
  it('turns OHLCV bars into four ordered trades each', () => {
    const text = `time,open,high,low,close,volume
1709287200000,10,12,9,11,40
1709287260000,11,11.5,8.5,9,80
`;
    const d = autoDetect(text);
    const i = new CsvImporter(d.mapping, d.options);
    i.push(text);
    const r = i.finish();
    expect(r.kind).toBe('bars');
    expect(r.barMs).toBe(60_000);
    expect(r.trades).toHaveLength(8);
    // Up bar: O, L, H, C. Down bar: O, H, L, C.
    expect(r.trades.slice(0, 4).map((t) => t.px / 10)).toEqual([10, 9, 12, 11]);
    expect(r.trades.slice(4).map((t) => t.px / 10)).toEqual([11, 11.5, 8.5, 9]);
    expect(r.trades.reduce((a, t) => a + t.qty, 0)).toBe(120);
    expect(r.trades.every((t) => t.ts >= 1709287200000 && t.ts < 1709287260000 + 60_000)).toBe(
      true,
    );
    expect(r.trades.every((t) => t.side !== 'unknown')).toBe(true);
  });

  it('rejects inconsistent bars', () => {
    const d = autoDetect('time,open,high,low,close\n1709287200000,10,9,11,10\n');
    const i = new CsvImporter(d.mapping, d.options);
    i.push('time,open,high,low,close\n1709287200000,10,9,11,10\n1709287260000,10,12,9,11\n');
    const r = i.finish();
    expect(r.rows).toBe(1);
    expect(r.errors[0]).toMatchObject({ line: 2 });
  });
});

describe('importCsv streaming', () => {
  async function* chunks(text: string, size: number) {
    for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
  }

  it('gives the same result for any chunk size and never needs the whole text', async () => {
    const lines = ['time,price,qty,side'];
    for (let i = 0; i < 5000; i++)
      lines.push(
        `${1709287200000 + i * 10},${(100 + (i % 7) / 100).toFixed(2)},${1 + (i % 3)},${i % 2 ? 'buy' : 'sell'}`,
      );
    const text = lines.join('\n') + '\n';
    const o = { ...DEFAULT_OPTIONS, timeFormat: 'epoch-ms' as const };
    const a = await importCsv(chunks(text, 4096), tradeMap, o);
    const b = await importCsv(chunks(text, 13), tradeMap, o);
    expect(a.rows).toBe(5000);
    expect(b.trades).toEqual(a.trades);
  });

  it('decodes byte streams split inside multi-byte characters', async () => {
    const text = 'time,price,qty,side,note\n1709287200000,1,1,buy,café €\n';
    const bytes = new TextEncoder().encode(text);
    async function* split() {
      for (let i = 0; i < bytes.length; i += 3) yield bytes.slice(i, i + 3);
    }
    const r = await importCsv(split(), tradeMap, { ...DEFAULT_OPTIONS, timeFormat: 'epoch-ms' });
    expect(r.rows).toBe(1);
  });

  it('reads a Blob through stream()', async () => {
    const r = await importCsv(new Blob([TRADES]), tradeMap, opts);
    expect(r.rows).toBe(3);
  });
});
