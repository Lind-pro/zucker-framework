import type { ColumnMapping } from './column-mapping';
import type { ImportRow, RowValidator } from './import.service';

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
  /** Maximum rows to import (0 = unlimited) */
  maxRows?: number;
}

/**
 * Import from a CSV stream.
 *
 * Uses a proper state-machine parser that handles quoted fields spanning
 * multiple lines/chunks correctly.
 */
export async function* importFromCsv<T = Record<string, unknown>>(
  stream: Readable,
  mapping: ColumnMapping[],
  options?: CsvImportOptions<T>,
): AsyncGenerator<ImportRow<T>> {
  const delimiter = options?.delimiter ?? ',';
  const maxRows = options?.maxRows ?? 0;
  let buffer = '';
  let headers: Map<number, ColumnMapping> | null = null;
  let rowNumber = 0;
  let yieldedRows = 0;
  let isFirstChunk = true;

  for await (const chunk of stream) {
    let text = typeof chunk === 'string'
      ? chunk
      : (chunk as Buffer).toString(options?.encoding ?? 'utf-8');

    // Strip BOM from first chunk
    if (isFirstChunk) {
      if (text.charCodeAt(0) === 0xfeff) {
        text = text.slice(1);
      }
      isFirstChunk = false;
    }

    buffer += text;

    // Process complete records from buffer
    // A record is complete when we have a newline outside of quotes
    while (true) {
      const result = extractNextRecord(buffer, delimiter);
      if (result === null) break; // Need more data

      const [line, remaining] = result;
      buffer = remaining;
      rowNumber++;

      if (maxRows > 0 && yieldedRows >= maxRows) break;

      if (rowNumber === 1) {
        headers = new Map();
        const headerCells = parseCsvLine(line, delimiter);
        for (let i = 0; i < headerCells.length; i++) {
          const col = mapping.find((m) => m.header === headerCells[i].trim());
          if (col) headers.set(i, col);
        }
        continue;
      }

      if (!headers) continue;

      const cells = parseCsvLine(line, delimiter);
      const data: Record<string, unknown> = {};
      const errors: string[] = [];

      for (const [colIdx, col] of headers) {
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

      yieldedRows++;
      yield { rowNumber, data: data as T, errors };
    }
  }

  // Handle remaining buffer (last line without trailing newline)
  if (buffer.trim() && headers) {
    rowNumber++;
    if (!(maxRows > 0 && yieldedRows >= maxRows)) {
      const cells = parseCsvLine(buffer.replace(/\r$/, ''), delimiter);
      const data: Record<string, unknown> = {};
      const errors: string[] = [];

      for (const [colIdx, col] of headers) {
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

      yield { rowNumber, data: data as T, errors };
    }
  }
}

/**
 * Export to CSV string.
 */
export async function exportToCsv<T = Record<string, unknown>>(
  data: T[] | AsyncIterable<T>,
  mapping: ColumnMapping[],
  options?: { delimiter?: string; lineEnding?: '\n' | '\r\n' },
): Promise<string> {
  const delimiter = options?.delimiter ?? ',';
  const lineEnding = options?.lineEnding ?? '\n';
  const lines: string[] = [];

  // Header row
  lines.push(mapping.map((col) => escapeCsvField(col.header, delimiter)).join(delimiter));

  // Data rows
  if (Symbol.asyncIterator in Object(data)) {
    for await (const item of data as AsyncIterable<T>) {
      lines.push(formatRow(item as Record<string, unknown>, mapping, delimiter));
    }
  } else {
    for (const item of data as T[]) {
      lines.push(formatRow(item as Record<string, unknown>, mapping, delimiter));
    }
  }

  return lines.join(lineEnding) + lineEnding;
}

function formatRow(
  item: Record<string, unknown>,
  mapping: ColumnMapping[],
  delimiter: string,
): string {
  return mapping
    .map((col) => {
      let value = item[col.field];
      if (col.converter?.export) value = col.converter.export(value);
      return escapeCsvField(String(value ?? ''), delimiter);
    })
    .join(delimiter);
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

/**
 * Extract the next complete CSV record from the buffer.
 * A record ends at a newline that is not inside a quoted field.
 *
 * Returns [record, remainingBuffer] or null if no complete record found.
 */
function extractNextRecord(
  buffer: string,
  _delimiter: string,
): [string, string] | null {
  let inQuotes = false;
  let i = 0;

  while (i < buffer.length) {
    const char = buffer[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < buffer.length && buffer[i + 1] === '"') {
          i += 2; // Skip escaped quote
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        i++;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
        i++;
      } else if (char === '\n') {
        const line = buffer.slice(0, i).replace(/\r$/, '');
        return [line, buffer.slice(i + 1)];
      } else {
        i++;
      }
    }
  }

  // If we're inside quotes, we need more data
  if (inQuotes) {
    return null;
  }

  // No newline found but not in quotes — wait for more data
  return null;
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
