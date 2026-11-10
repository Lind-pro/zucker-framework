import type { ColumnMapping } from './column-mapping';
import type { ImportRow, RowValidator } from './import.service';

import { StringDecoder } from 'node:string_decoder';

type Readable = import('stream').Readable;

/**
 * CSV import/export — lightweight, no external dependencies.
 *
 * Properly handles:
 * - Quoted fields with embedded delimiters, newlines, and escaped quotes
 * - Different encodings via the encoding option
 * - BOM detection and removal for UTF-8/UTF-16
 * - Row-level validation
 */

export interface CsvImportOptions<T = Record<string, unknown>> {
  delimiter?: string;
  encoding?: BufferEncoding;
  /** Row-level validator */
  validator?: RowValidator<T>;
  /** Maximum rows to import (0 = unlimited). Reading stops once reached. */
  maxRows?: number;
  /**
   * Maximum characters in one record (including quoted newlines). A longer record, e.g. caused by an
   * unterminated quote, aborts the import with an error instead of buffering the rest of the file.
   * Default 1 MiB characters; 0 disables the limit.
   */
  maxRecordLength?: number;
}

const DEFAULT_MAX_RECORD_LENGTH = 1024 * 1024;

/**
 * Import from a CSV stream.
 *
 * Uses a proper state-machine parser that handles quoted fields spanning
 * multiple lines/chunks correctly. Multi-byte characters split across chunks are
 * decoded with a streaming decoder.
 */
export async function* importFromCsv<T = Record<string, unknown>>(
  stream: Readable,
  mapping: ColumnMapping[],
  options?: CsvImportOptions<T>,
): AsyncGenerator<ImportRow<T>> {
  const delimiter = options?.delimiter ?? ',';
  const maxRows = options?.maxRows ?? 0;
  const maxRecordLength = options?.maxRecordLength ?? DEFAULT_MAX_RECORD_LENGTH;
  const decoder = new StringDecoder(options?.encoding ?? 'utf-8');
  const scanner = new RecordScanner(maxRecordLength);
  let headers: Map<number, ColumnMapping> | null = null;
  let missingRequired: string[] = [];
  let rowNumber = 0;
  let yieldedRows = 0;
  let isFirstText = true;

  const toRow = (line: string): ImportRow<T> => {
    const cells = parseCsvLine(line, delimiter);
    const data: Record<string, unknown> = {};
    const errors: string[] = missingRequired.map(
      (header) => `Column "${header}": required column is missing`,
    );

    for (const [colIdx, col] of headers!) {
      let value: unknown = cells[colIdx] ?? '';
      if (col.converter?.import) {
        try {
          value = col.converter.import(value);
        } catch (e) {
          errors.push(
            `Column "${col.header}": conversion error - ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      if (col.required && (value === undefined || value === null || value === '')) {
        errors.push(`Column "${col.header}": required field is empty`);
      }
      data[col.field] = value;
    }

    // Row-level validation
    if (options?.validator && errors.length === 0) {
      try {
        const validationError = options.validator(data as T, rowNumber);
        if (typeof validationError === 'string') {
          errors.push(validationError);
        }
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    return { rowNumber, data: data as T, errors };
  };

  const readHeader = (line: string) => {
    headers = new Map();
    const headerCells = parseCsvLine(line, delimiter).map((cell) => cell.trim());
    for (let i = 0; i < headerCells.length; i++) {
      const col = mapping.find((m) => m.header === headerCells[i]);
      if (col) headers.set(i, col);
    }
    const present = new Set(headers.values());
    missingRequired = mapping.filter((m) => m.required && !present.has(m)).map((m) => m.header);
  };

  const chunks = async function* () {
    for await (const chunk of stream) {
      yield typeof chunk === 'string' ? chunk : decoder.write(chunk as Buffer);
    }
    const tail = decoder.end();
    if (tail) yield tail;
  };

  for await (let text of chunks()) {
    // Strip BOM from the first decoded text
    if (isFirstText && text) {
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      isFirstText = false;
    }
    scanner.push(text);

    // A record is complete when we have a newline outside of quotes
    for (let line = scanner.next(); line !== null; line = scanner.next()) {
      rowNumber++;
      if (rowNumber === 1) {
        readHeader(line);
        continue;
      }
      yieldedRows++;
      yield toRow(line);
      // Stop reading the stream as soon as the limit is reached.
      if (maxRows > 0 && yieldedRows >= maxRows) return;
    }
  }

  // Handle remaining buffer (last line without trailing newline)
  const rest = scanner.rest();
  if (rest.trim() && headers) {
    rowNumber++;
    if (!(maxRows > 0 && yieldedRows >= maxRows)) {
      yield toRow(rest.replace(/\r$/, ''));
    }
  }
}

/**
 * Incremental record splitter. The scan position and quote state survive between chunks, so each
 * character is examined once (no rescanning of a long pending record on every chunk).
 */
class RecordScanner {
  private buffer = '';
  private pos = 0;
  private inQuotes = false;

  constructor(private readonly maxRecordLength: number) {}

  push(text: string): void {
    this.buffer += text;
    if (this.maxRecordLength > 0 && this.buffer.length > this.maxRecordLength && this.peekNewline() < 0) {
      throw new Error(`CSV record exceeds the maximum length of ${this.maxRecordLength} characters`);
    }
  }

  /** Returns the next complete record (without its line ending) or null when more data is needed. */
  next(): string | null {
    const end = this.peekNewline();
    if (end < 0) return null;
    const line = this.buffer.slice(0, end).replace(/\r$/, '');
    this.buffer = this.buffer.slice(end + 1);
    this.pos = 0;
    this.inQuotes = false;
    return line;
  }

  rest(): string {
    const rest = this.buffer;
    this.buffer = '';
    this.pos = 0;
    this.inQuotes = false;
    return rest;
  }

  // Advances the persistent scan state to the next newline outside quotes; returns its index or -1.
  private peekNewline(): number {
    const buffer = this.buffer;
    while (this.pos < buffer.length) {
      const char = buffer[this.pos];
      if (this.inQuotes) {
        if (char === '"') {
          if (this.pos + 1 >= buffer.length) return -1; // cannot tell "" from " yet
          if (buffer[this.pos + 1] === '"') {
            this.pos += 2;
            continue;
          }
          this.inQuotes = false;
        }
        this.pos++;
      } else if (char === '"') {
        this.inQuotes = true;
        this.pos++;
      } else if (char === '\n') {
        if (this.maxRecordLength > 0 && this.pos > this.maxRecordLength) {
          throw new Error(`CSV record exceeds the maximum length of ${this.maxRecordLength} characters`);
        }
        return this.pos;
      } else {
        this.pos++;
      }
    }
    return -1;
  }
}

export interface CsvExportOptions {
  delimiter?: string;
  lineEnding?: '\n' | '\r\n';
  /**
   * Prefix cells that a spreadsheet would evaluate as a formula (starting with `=`, `+`, `-`, `@`,
   * tab or carriage return) with `'`. Plain numbers such as `-5` are left unchanged. Default true.
   */
  escapeFormulas?: boolean;
}

/**
 * Export to CSV string.
 */
export async function exportToCsv<T = Record<string, unknown>>(
  data: T[] | AsyncIterable<T>,
  mapping: ColumnMapping[],
  options?: CsvExportOptions,
): Promise<string> {
  const delimiter = options?.delimiter ?? ',';
  const escapeFormulas = options?.escapeFormulas ?? true;
  const lineEnding = options?.lineEnding ?? '\n';
  const lines: string[] = [];

  // Header row
  lines.push(mapping.map((col) => escapeCsvField(col.header, delimiter)).join(delimiter));

  // Data rows
  if (Symbol.asyncIterator in Object(data)) {
    for await (const item of data as AsyncIterable<T>) {
      lines.push(formatRow(item as Record<string, unknown>, mapping, delimiter, escapeFormulas));
    }
  } else {
    for (const item of data as T[]) {
      lines.push(formatRow(item as Record<string, unknown>, mapping, delimiter, escapeFormulas));
    }
  }

  return lines.join(lineEnding) + lineEnding;
}

function formatRow(
  item: Record<string, unknown>,
  mapping: ColumnMapping[],
  delimiter: string,
  escapeFormulas: boolean,
): string {
  return mapping
    .map((col) => {
      let value = item[col.field];
      if (col.converter?.export) value = col.converter.export(value);
      const text = String(value ?? '');
      return escapeCsvField(escapeFormulas ? neutralizeFormula(text) : text, delimiter);
    })
    .join(delimiter);
}

const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Neutralises CSV/formula injection (OWASP): spreadsheet apps evaluate cells starting with these. */
function neutralizeFormula(value: string): string {
  return FORMULA_START.test(value) && !PLAIN_NUMBER.test(value) ? `'${value}` : value;
}

function escapeCsvField(value: string, delimiter: string): string {
  if (
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r')
  ) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function parseCsvLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        current += char;
        i++;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
        i++;
      } else if (char === delimiter) {
        fields.push(current);
        current = '';
        i++;
      } else {
        current += char;
        i++;
      }
    }
  }

  fields.push(current);
  return fields;
}
