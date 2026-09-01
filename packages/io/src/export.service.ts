import type { ColumnMapping } from './column-mapping';
import type { Writable } from 'stream';

export interface ExportOptions {
  sheetName?: string;
  /** Freeze the header row */
  freezeHeader?: boolean;
  /** Auto-filter on columns */
  autoFilter?: boolean;
}

/**
 * Export data to an Excel buffer.
 *
 * Supports both arrays and async iterables for streaming large datasets.
 */
export async function exportToExcel<T = Record<string, unknown>>(
  data: T[] | AsyncIterable<T>,
  mapping: ColumnMapping[],
  options?: ExportOptions,
): Promise<Buffer> {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.default.Workbook();
  const sheet = workbook.addWorksheet(options?.sheetName ?? 'Sheet1');

  // Set up columns
  sheet.columns = mapping.map((col) => ({
    header: col.header,
    key: col.field,
    width: col.width ?? 15,
  }));

  // Style header row
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };

  // Freeze header row if requested
  if (options?.freezeHeader !== false) {
    sheet.views = [{ state: 'frozen' as const, ySplit: 1 }];
  }

  // Add data rows
  if (Symbol.asyncIterator in Object(data)) {
    for await (const item of data as AsyncIterable<T>) {
      addRow(sheet, item as Record<string, unknown>, mapping);
    }
  } else {
    for (const item of data as T[]) {
      addRow(sheet, item as Record<string, unknown>, mapping);
    }
  }

  // Auto-filter if requested
  if (options?.autoFilter && sheet.rowCount > 1) {
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: sheet.rowCount, column: mapping.length },
    };
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/**
 * Stream export to a writable stream — avoids buffering entire workbook in memory.
 *
 * Mirrors jetlinks ExcelUtils.write() streaming pattern.
 * Uses ExcelJS StreamWorkbookWriter for memory-efficient large exports.
 */
export async function exportToExcelStream<T = Record<string, unknown>>(
  data: AsyncIterable<T>,
  mapping: ColumnMapping[],
  output: Writable,
  options?: ExportOptions,
): Promise<void> {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.default.stream.xlsx.WorkbookWriter({
    stream: output,
    useStyles: true,
  });

  const sheet = workbook.addWorksheet(options?.sheetName ?? 'Sheet1');

  // Set up columns
  sheet.columns = mapping.map((col) => ({
    header: col.header,
    key: col.field,
    width: col.width ?? 15,
  }));

  // Style header row
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.commit();

  // Stream data rows
  let rowNum = 1;
  for await (const item of data) {
    rowNum++;
    const rowData: Record<string, unknown> = {};
    for (const col of mapping) {
      let value = (item as Record<string, unknown>)[col.field];
      if (col.converter?.export) {
        value = col.converter.export(value);
      }
      rowData[col.field] = value;
    }
    const row = sheet.addRow(rowData);
    row.commit();
  }

  await sheet.commit();
  await workbook.commit();
}

function addRow(
  sheet: { addRow(data: Record<string, unknown>): unknown },
  item: Record<string, unknown>,
  mapping: ColumnMapping[],
): void {
  const rowData: Record<string, unknown> = {};
  for (const col of mapping) {
    let value = item[col.field];
    if (col.converter?.export) {
      value = col.converter.export(value);
    }
    rowData[col.field] = value;
  }
  sheet.addRow(rowData);
}
