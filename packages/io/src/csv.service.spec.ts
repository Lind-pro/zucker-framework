import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { exportToCsv, importFromCsv } from './csv.service';
import { detectFormatFromBuffer } from './format-detect';
import type { ColumnMapping } from './column-mapping';

const mapping: ColumnMapping[] = [
  { header: 'name', field: 'name', required: true },
  { header: 'city', field: 'city' },
];

async function collect(stream: Readable, map = mapping, options = {}) {
  const rows = [];
  for await (const row of importFromCsv(stream, map, options)) rows.push(row);
  return rows;
}

describe('importFromCsv', () => {
  it('decodes multi-byte characters split across chunks (H6)', async () => {
    const bytes = Buffer.from('name,city\n张三丰,北京\n', 'utf-8');
    const split = bytes.indexOf(Buffer.from('张三丰')) + 1; // inside the first character
    const chunks = [bytes.subarray(0, split), bytes.subarray(split, split + 4), bytes.subarray(split + 4)];
    const rows = await collect(Readable.from(chunks, { objectMode: false }));
    expect(rows).toHaveLength(1);
    expect(rows[0].data).toEqual({ name: '张三丰', city: '北京' });
  });

  it('reports a required column that is missing from the header (M8)', async () => {
    const rows = await collect(Readable.from([Buffer.from('city\n北京\n')]));
    expect(rows[0].errors).toContain('Column "name": required column is missing');
  });

  it('fails fast on an unterminated quote instead of buffering the whole file (M8)', async () => {
    const huge = Array.from({ length: 50 }, () => Buffer.from('x'.repeat(1000) + '\n'));
    const stream = Readable.from([Buffer.from('name,city\n"open,quote\n'), ...huge]);
    await expect(collect(stream, mapping, { maxRecordLength: 10_000 })).rejects.toThrow('maximum length');
  });

  it('stops reading the stream once maxRows is reached (M8)', async () => {
    let pulled = 0;
    async function* source() {
      yield Buffer.from('name,city\n');
      for (let i = 0; i < 1000; i++) {
        pulled++;
        yield Buffer.from(`n${i},c\n`);
      }
    }
    const rows = await collect(Readable.from(source()), mapping, { maxRows: 2 });
    expect(rows).toHaveLength(2);
    expect(pulled).toBeLessThan(10);
  });

  it('keeps quoted fields with embedded newlines and escaped quotes across chunks', async () => {
    const rows = await collect(Readable.from([Buffer.from('name,city\n"a ""q'), Buffer.from('""\nb",x\nlast,y')]));
    expect(rows.map((r) => r.data)).toEqual([
      { name: 'a "q"\nb', city: 'x' },
      { name: 'last', city: 'y' },
    ]);
  });
});

describe('exportToCsv', () => {
  it('neutralises spreadsheet formulas by default (M9)', async () => {
    const csv = await exportToCsv(
      [
        { name: '=HYPERLINK("http://x","y")', city: '+cmd|calc' },
        { name: '@SUM(1)', city: '-5' },
      ],
      mapping,
    );
    expect(csv).toBe('name,city\n"\'=HYPERLINK(""http://x"",""y"")",\'+cmd|calc\n\'@SUM(1),-5\n');
  });

  it('can disable formula escaping', async () => {
    const csv = await exportToCsv([{ name: '=1+1', city: '' }], mapping, { escapeFormulas: false });
    expect(csv).toBe('name,city\n=1+1,\n');
  });
});

describe('detectFormatFromBuffer (L11)', () => {
  it('detects CSV that starts with a BOM or non-ASCII header', () => {
    expect(detectFormatFromBuffer(Buffer.from('﻿name,city\n', 'utf-8'))).toBe('csv');
    expect(detectFormatFromBuffer(Buffer.from('姓名,城市\n张三,北京\n', 'utf-8'))).toBe('csv');
    expect(detectFormatFromBuffer(Buffer.from('﻿[1]', 'utf-8'))).toBe('json');
    expect(detectFormatFromBuffer(Buffer.from([0x00, 0x01, 0x02, 0xff]))).toBeNull();
  });
});
