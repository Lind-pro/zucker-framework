import type { ColumnMapping } from './column-mapping';

type Readable = import('stream').Readable;

export interface ImportRow<T> {
  rowNumber: number;
  data: T;
  errors: string[];
}

/**
 * Row-level validation function.
 * Throw an error or return an error string to mark the row as invalid.
 */
export type RowValidator<T> = (data: T, rowNumber: number) => string | void;

export interface ImportExcelOptions<T> {
  /** Row-level validator, called after conversion */
  validator?: RowValidator<T>;
  /** Maximum number of rows to import (0 = unlimited) */
  maxRows?: number;
  /** Which worksheet to read (0-based index, default: 0) */
  sheetIndex?: number;
}

/**
 * Import data from an Excel file stream.
 *
 * Uses streaming mode to avoid loading the entire file into memory.
 * Supports row-level validation and error collection per row.
 *
 * Mirrors jetlinks ExcelUtils.read() + ImportHelper validation flow.
 */
export async function* importFromExcel<T = Record<string, unknown>>(
  stream: Readable,
  mapping: ColumnMapping[],
  options?: ImportExcelOptions<T>,
): AsyncGenerator<ImportRow<T>> {
  // Dynamic import to keep exceljs as optional runtime dependency
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.default.stream.xlsx.WorkbookReader(stream, {});

  let sheetCount = 0;
  const targetSheet = options?.sheetIndex ?? 0;
  const maxRows = options?.maxRows ?? 0;
  let yieldedRows = 0;

  for await (const worksheet of workbook) {
    if (sheetCount !== targetSheet) {
      sheetCount++;
      continue;
    }
    sheetCount++;

    let headers: Map<number, ColumnMapping> | null = null;
    let missingRequired: string[] = [];
    let rowNumber = 0;

    for await (const row of worksheet) {
      rowNumber++;

      if (rowNumber === 1) {
        // Parse header row to determine column mapping
        headers = new Map();
        row.eachCell({ includeEmpty: false }, (cell: { value: unknown }, colNumber: number) => {
          const headerText = String(cell.value ?? '').trim();
          const col = mapping.find((m) => m.header === headerText);
          if (col) {
            headers!.set(colNumber, col);
          }
        });
        // A required mapping whose column is absent from the sheet fails every row.
        const present = new Set(headers.values());
        missingRequired = mapping.filter((m) => m.required && !present.has(m)).map((m) => m.header);
        continue;
      }

      if (!headers) continue;
      if (maxRows > 0 && yieldedRows >= maxRows) break;

      const data: Record<string, unknown> = {};
      const errors: string[] = missingRequired.map(
        (header) => `Column "${header}": required column is missing`,
      );

      for (const [colNumber, col] of headers) {
        const cell = row.getCell(colNumber);
        let value: unknown = cell.value;

        // Handle ExcelJS rich text
        if (value && typeof value === 'object' && 'richText' in value) {
          value = (value as { richText: Array<{ text: string }> }).richText
            .map((rt) => rt.text)
            .join('');
        }

        // Handle ExcelJS hyperlink
        if (value && typeof value === 'object' && 'hyperlink' in value) {
          value = (value as unknown as { text: string }).text;
        }

        // Handle ExcelJS formula result
        if (value && typeof value === 'object' && 'result' in value) {
          value = (value as unknown as { result: unknown }).result;
        }

        // Handle ExcelJS error value
        if (value && typeof value === 'object' && 'error' in value) {
          errors.push(`Column "${col.header}": cell contains error value`);
          value = undefined;
        }

        if (col.converter?.import) {
          try {
            value = col.converter.import(value);
          } catch (e) {
            errors.push(
              `Column "${col.header}": conversion error - ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }

        // Required field check
        if (col.required && (value === undefined || value === null || value === '')) {
          errors.push(`Column "${col.header}": required field is empty`);
        }

        data[col.field] = value;
      }

      // Run row-level validator
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

    // Only process target worksheet
    break;
  }
}
