import { describe, it, expect } from 'vitest';
import {
  detectFormatFromFilename,
  detectFormatFromMimeType,
  detectFormatFromBuffer,
} from './format-detect';

describe('detectFormatFromFilename', () => {
  it('should detect xlsx extension', () => {
    expect(detectFormatFromFilename('data.xlsx')).toBe('xlsx');
  });

  it('should detect xls extension as xlsx', () => {
    expect(detectFormatFromFilename('report.xls')).toBe('xlsx');
  });

  it('should detect csv extension', () => {
    expect(detectFormatFromFilename('data.csv')).toBe('csv');
  });

  it('should detect tsv extension as csv', () => {
    expect(detectFormatFromFilename('data.tsv')).toBe('csv');
  });

  it('should detect json extension', () => {
    expect(detectFormatFromFilename('config.json')).toBe('json');
  });

  it('should return null for unknown extension', () => {
    expect(detectFormatFromFilename('file.txt')).toBeNull();
    expect(detectFormatFromFilename('image.png')).toBeNull();
  });

  it('should be case insensitive', () => {
    expect(detectFormatFromFilename('DATA.XLSX')).toBe('xlsx');
    expect(detectFormatFromFilename('file.CSV')).toBe('csv');
    expect(detectFormatFromFilename('config.JSON')).toBe('json');
  });

  it('should handle filenames with multiple dots', () => {
    expect(detectFormatFromFilename('my.data.file.xlsx')).toBe('xlsx');
  });
});

describe('detectFormatFromMimeType', () => {
  it('should detect Excel MIME types', () => {
    expect(detectFormatFromMimeType('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('xlsx');
    expect(detectFormatFromMimeType('application/vnd.ms-excel')).toBe('xlsx');
  });

  it('should detect CSV MIME type', () => {
    expect(detectFormatFromMimeType('text/csv')).toBe('csv');
  });

  it('should detect TSV MIME type', () => {
    expect(detectFormatFromMimeType('text/tab-separated-values')).toBe('csv');
  });

  it('should detect JSON MIME type', () => {
    expect(detectFormatFromMimeType('application/json')).toBe('json');
  });

  it('should return null for unknown MIME type', () => {
    expect(detectFormatFromMimeType('text/plain')).toBeNull();
    expect(detectFormatFromMimeType('image/png')).toBeNull();
  });

  it('should be case insensitive', () => {
    expect(detectFormatFromMimeType('APPLICATION/JSON')).toBe('json');
    expect(detectFormatFromMimeType('Text/CSV')).toBe('csv');
  });

  it('should detect excel keyword in MIME', () => {
    expect(detectFormatFromMimeType('application/excel')).toBe('xlsx');
  });
});

describe('detectFormatFromBuffer', () => {
  it('should detect XLSX/ZIP by magic bytes (PK)', () => {
    const buf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
    expect(detectFormatFromBuffer(buf)).toBe('xlsx');
  });

  it('should detect JSON starting with {', () => {
    const buf = Buffer.from('{"key": "value"}');
    expect(detectFormatFromBuffer(buf)).toBe('json');
  });

  it('should detect JSON starting with [', () => {
    const buf = Buffer.from('[1, 2, 3]');
    expect(detectFormatFromBuffer(buf)).toBe('json');
  });

  it('should detect JSON with leading whitespace', () => {
    const buf = Buffer.from('  \n  {"data": true}');
    expect(detectFormatFromBuffer(buf)).toBe('json');
  });

  it('should detect CSV as fallback for text content', () => {
    const buf = Buffer.from('name,age,city\nAlice,30,NYC');
    expect(detectFormatFromBuffer(buf)).toBe('csv');
  });

  it('should return null for too-short buffer', () => {
    const buf = Buffer.from([0x00]);
    expect(detectFormatFromBuffer(buf)).toBeNull();
  });

  it('should return null for empty buffer', () => {
    const buf = Buffer.alloc(0);
    expect(detectFormatFromBuffer(buf)).toBeNull();
  });

  it('should return null for binary non-ZIP content', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
    expect(detectFormatFromBuffer(buf)).toBeNull();
  });
});
