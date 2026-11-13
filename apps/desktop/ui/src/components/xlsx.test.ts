import { describe, expect, it } from 'vitest';
import { buildXlsx, columnName, crc32, sheetName, zipStore } from './xlsx';

interface Entry {
  name: string;
  data: Uint8Array;
  crc: number;
  method: number;
}

/** Reads a ZIP through its central directory (the way real readers do). */
function readZip(buf: Uint8Array): Entry[] {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--)
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  expect(eocd).toBeGreaterThanOrEqual(0);
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out: Entry[] = [];
  for (let n = 0; n < count; n++) {
    expect(v.getUint32(p, true)).toBe(0x02014b50);
    const method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true);
    const size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const off = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    expect(v.getUint32(off, true)).toBe(0x04034b50);
    const dataStart = off + 30 + v.getUint16(off + 26, true) + v.getUint16(off + 28, true);
    out.push({ name, data: buf.slice(dataStart, dataStart + size), crc, method });
    p += 46 + nameLen;
  }
  return out;
}

describe('xlsx writer (P20)', () => {
  it('crc32 matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('builds a valid store-only zip with the required parts', () => {
    const zip = buildXlsx('Orders', ['Instrument', 'Qty'], [['NQ', 2]]);
    expect(zip[0]).toBe(0x50);
    expect(zip[1]).toBe(0x4b);
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/worksheets/sheet1.xml',
    ]);
    for (const e of entries) {
      expect(e.method).toBe(0);
      expect(crc32(e.data)).toBe(e.crc);
    }
  });

  it('sheet1.xml holds the header and data rows, escaped', () => {
    const zip = buildXlsx(
      'T',
      ['Name', 'Value'],
      [
        ['A & <B>', 1.5],
        ['x', null],
        ['', -3],
      ],
    );
    const sheet = new TextDecoder().decode(
      readZip(zip).find((e) => e.name === 'xl/worksheets/sheet1.xml')!.data,
    );
    expect(sheet).toContain(
      '<c r="A1" t="inlineStr"><is><t xml:space="preserve">Name</t></is></c>',
    );
    expect(sheet).toContain('A &amp; &lt;B&gt;');
    expect(sheet).toContain('<c r="B2"><v>1.5</v></c>');
    expect(sheet).toContain('<row r="3"><c r="A3" t="inlineStr">');
    expect(sheet).toContain('<c r="B4"><v>-3</v></c>');
    expect(sheet.match(/<row /g)).toHaveLength(4);
  });

  it('names columns and sanitises sheet names', () => {
    expect(columnName(0)).toBe('A');
    expect(columnName(25)).toBe('Z');
    expect(columnName(26)).toBe('AA');
    expect(columnName(701)).toBe('ZZ');
    expect(sheetName('a/b:c')).toBe('a b c');
    expect(sheetName('  ')).toBe('Sheet1');
    expect(sheetName('x'.repeat(50))).toHaveLength(31);
  });

  it('zipStore round-trips arbitrary bytes', () => {
    const data = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);
    const [e] = readZip(zipStore([{ name: 'a.bin', data }]));
    expect(e!.data).toEqual(data);
  });
});
