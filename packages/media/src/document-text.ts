import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inflateRawSync } from 'node:zlib';

// ZIP's IEEE CRC-32. Avoid a Node 22-only named import in the default entry:
// library consumers may use Node 20 even when the maintainer toolchain is newer.
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

export class DocumentTextError extends Error {
  constructor(public readonly code: 'INVALID_ZIP' | 'OCR_PAGE_LIMIT', message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DocumentTextError';
  }
}
export interface ExtractedDocumentText { text: string; pageCount?: number; ocrUsed: boolean }
export interface PdfTextResult { text: string; total: number; pages: { num: number; text: string }[] }
export interface PdfTextParser { getText(): Promise<PdfTextResult>; destroy(): Promise<void> }
export interface DocumentZipEntry {
  size: number; crc: number; encrypted: boolean; method: number;
  /** Compressed bytes, never a pre-inflated unbounded allocation. Include all entries. */
  compressed(): Uint8Array;
}
export interface DocumentZipLimits { maxEntries: number; maxEntryBytes: number; maxTotalBytes: number }
export interface DocumentTextOptions {
  maxOcrPages: number;
  minTextCharacters: number;
  maxInputPixels: number;
  imageMaxDimension: number;
  zip: DocumentZipLimits;
  languages: string;
  pageSegmentationModes: readonly number[];
  rasterDpi: number;
  commandTimeoutMs: number;
  commandMaxBuffer: number;
  tempRoot?: string;
}
export interface DocumentTextPorts {
  pdf(buffer: Buffer): PdfTextParser;
  docx(buffer: Buffer): Promise<string>;
  zipEntries(buffer: Buffer): Iterable<DocumentZipEntry>;
  /** Must enforce limitInputPixels in the decoder, before decoding/allocation. Return PNG. */
  image(buffer: Buffer, options: { limitInputPixels: number; maxDimension: number }): Promise<Buffer>;
  office(buffer: Buffer, format: 'doc' | 'docx', signal?: AbortSignal): Promise<Buffer>;
  execute?: DocumentCommand;
}
export type DocumentCommand = (
  file: string, args: string[], options: { signal?: AbortSignal; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string }>;
/** execFile, never a shell; waits for the child close event even after cancellation. */
export const executeDocumentCommand: DocumentCommand = (file, args, options) => new Promise((resolve, reject) => {
  let result: { stdout: string } | undefined;
  let failure: unknown;
  // execFile's callback may run on AbortError before the child has actually exited.
  const child = execFile(file, args, { ...options, encoding: 'utf8' }, (error, stdout) => {
    failure = error;
    result = { stdout };
  });
  child.once('close', () => {
    if (options.signal?.aborted) reject(options.signal.reason);
    else if (failure) reject(failure);
    else resolve(result ?? { stdout: '' });
  });
});

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
}

/** Validate every member, including ones a document parser may access but an application would hide. */
export function validateDocumentZip(entries: Iterable<DocumentZipEntry>, limits: DocumentZipLimits): void {
  for (const [name, value] of Object.entries(limits)) positiveInteger(value, name);
  let count = 0;
  let total = 0;
  for (const entry of entries) {
    if (++count > limits.maxEntries) throw new RangeError('ZIP entry limit exceeded');
    const remaining = Math.min(limits.maxEntryBytes, limits.maxTotalBytes - total);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > remaining || entry.encrypted) {
      throw new RangeError('Invalid or oversized ZIP entry');
    }
    const compressed = entry.compressed();
    const data = entry.method === 0 ? compressed : entry.method === 8
      ? inflateRawSync(compressed, { maxOutputLength: Math.max(1, remaining) })
      : undefined;
    if (!data || data.length > remaining || data.length !== entry.size || crc32(data) !== (entry.crc >>> 0)) {
      throw new Error('Invalid ZIP content or checksum');
    }
    total += data.length;
  }
}

/** SDK-neutral extraction orchestration. Limits/language/Office policy must be supplied by the application. */
export class DocumentTextExtractor {
  private readonly execute: DocumentCommand;
  constructor(private readonly ports: DocumentTextPorts, private readonly options: DocumentTextOptions) {
    for (const key of ['maxOcrPages', 'minTextCharacters', 'maxInputPixels', 'imageMaxDimension', 'rasterDpi', 'commandTimeoutMs', 'commandMaxBuffer'] as const) {
      positiveInteger(options[key], key);
    }
    for (const [key, value] of Object.entries(options.zip)) positiveInteger(value, key);
    if (!options.languages.trim() || !options.pageSegmentationModes.length || options.pageSegmentationModes.some((n) => !Number.isInteger(n) || n < 0 || n > 13)) {
      throw new RangeError('OCR language and valid segmentation modes are required');
    }
    this.execute = ports.execute ?? executeDocumentCommand;
  }

  async extract(buffer: Buffer, format: 'pdf' | 'docx' | 'doc' | 'image', signal?: AbortSignal): Promise<ExtractedDocumentText> {
    signal?.throwIfAborted();
    if (format === 'pdf') return this.pdf(buffer, signal);
    if (format === 'docx') {
      try { validateDocumentZip(this.ports.zipEntries(buffer), this.options.zip); }
      catch (cause) { throw new DocumentTextError('INVALID_ZIP', 'Invalid document ZIP', { cause }); }
      const text = await this.ports.docx(buffer);
      signal?.throwIfAborted();
      if (text.trim().length >= this.options.minTextCharacters) return { text, ocrUsed: false };
    }
    if (format === 'doc' || format === 'docx') {
      const pdf = await this.ports.office(buffer, format, signal);
      signal?.throwIfAborted();
      return this.pdf(pdf, signal);
    }
    if (format !== 'image') throw new TypeError('Unsupported document format');
    return this.temporary(async (directory) => {
      const image = await this.ports.image(buffer, {
        limitInputPixels: this.options.maxInputPixels, maxDimension: this.options.imageMaxDimension,
      });
      signal?.throwIfAborted();
      const file = join(directory, 'image.png');
      await writeFile(file, image);
      return { text: await this.ocr(file, signal), pageCount: 1, ocrUsed: true };
    });
  }

  private async pdf(buffer: Buffer, signal?: AbortSignal): Promise<ExtractedDocumentText> {
    signal?.throwIfAborted();
    const parser = this.ports.pdf(buffer);
    let destruction: Promise<void> | undefined;
    const destroy = () => destruction ??= Promise.resolve().then(() => parser.destroy());
    const abort = () => { void destroy().catch(() => undefined); };
    signal?.addEventListener('abort', abort, { once: true });
    let result: PdfTextResult;
    try {
      signal?.throwIfAborted();
      result = await parser.getText();
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      await destroy();
    }
    signal?.throwIfAborted();
    const scanned = result.pages.filter((page) => this.characters(page.text) < this.options.minTextCharacters);
    if (!scanned.length) return { text: result.text, pageCount: result.total, ocrUsed: false };
    if (scanned.length > this.options.maxOcrPages) throw new DocumentTextError('OCR_PAGE_LIMIT', 'OCR page limit exceeded');
    return this.temporary(async (directory) => {
      const file = join(directory, 'document.pdf');
      await writeFile(file, buffer);
      const recognized = new Map<number, string>();
      for (const page of scanned) {
        positiveInteger(page.num, 'PDF page number');
        const prefix = join(directory, `page-${page.num}`);
        await this.command('pdftoppm', ['-f', String(page.num), '-l', String(page.num), '-singlefile', '-r', String(this.options.rasterDpi), '-scale-to', String(Math.min(this.options.imageMaxDimension, Math.floor(Math.sqrt(this.options.maxInputPixels)))), '-gray', '-png', file, prefix], signal);
        recognized.set(page.num, await this.ocr(`${prefix}.png`, signal));
      }
      return { text: result.pages.map((page) => recognized.get(page.num) || page.text).join('\n\n'), pageCount: result.total, ocrUsed: true };
    });
  }

  private characters(text: string): number { return text.replace(/\s/g, '').length; }
  private async command(file: string, args: string[], signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const result = await this.execute(file, args, { signal, timeout: this.options.commandTimeoutMs, maxBuffer: this.options.commandMaxBuffer });
    signal?.throwIfAborted();
    return result.stdout.trim();
  }
  private async ocr(file: string, signal?: AbortSignal): Promise<string> {
    let best = '';
    for (const mode of this.options.pageSegmentationModes) {
      const text = await this.command('tesseract', [file, 'stdout', '-l', this.options.languages, '--psm', String(mode)], signal);
      if (this.characters(text) > this.characters(best)) best = text;
      if (this.characters(best) >= this.options.minTextCharacters) break;
    }
    return best;
  }
  private async temporary<T>(work: (directory: string) => Promise<T>): Promise<T> {
    const directory = await mkdtemp(join(this.options.tempRoot ?? tmpdir(), 'document-text-'));
    try { return await work(directory); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
}
