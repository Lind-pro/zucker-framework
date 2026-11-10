/**
 * Supported import/export file formats.
 * Mirrors jetlinks ImportHelper format constants.
 */
export type FileFormat = 'xlsx' | 'csv' | 'json';

/**
 * Detect file format from filename extension.
 */
export function detectFormatFromFilename(filename: string): FileFormat | null {
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'xlsx':
    case 'xls':
      return 'xlsx';
    case 'csv':
    case 'tsv':
      return 'csv';
    case 'json':
      return 'json';
    default:
      return null;
  }
}

/**
 * Detect file format from MIME type.
 */
export function detectFormatFromMimeType(mimeType: string): FileFormat | null {
  const type = mimeType.toLowerCase();
  if (
    type.includes('spreadsheetml') ||
    type.includes('excel') ||
    type === 'application/vnd.ms-excel'
  ) {
    return 'xlsx';
  }
  if (type === 'text/csv' || type === 'text/tab-separated-values') {
    return 'csv';
  }
  if (type === 'application/json') {
    return 'json';
  }
  return null;
}

/**
 * Detect file format by inspecting file magic bytes.
 *
 * - XLSX (ZIP): starts with PK (0x50 0x4B)
 * - JSON: starts with [ or {
 * - CSV: fallback if text-like content
 */
export function detectFormatFromBuffer(buffer: Buffer): FileFormat | null {
  if (buffer.length < 2) return null;

  // XLSX/ZIP magic bytes: PK\x03\x04
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
    return 'xlsx';
  }

  // Try to detect JSON vs CSV from first non-whitespace character (UTF-8 BOM ignored)
  const head = buffer.subarray(0, Math.min(buffer.length, 1024));
  const text = head.toString('utf-8').replace(/^\uFEFF/, '').trimStart();
  if (text.startsWith('[') || text.startsWith('{')) {
    return 'json';
  }

  // Default to CSV if it looks like text: printable ASCII or valid UTF-8 (e.g. a Chinese header).
  // A replacement character is tolerated only at the very end, where the sample may cut a character.
  const body = text.replace(/\uFFFD{1,3}$/, '');
  if (body && !/[\x00-\x08\x0E-\x1F\uFFFD]/.test(body)) {
    return 'csv';
  }

  return null;
}
