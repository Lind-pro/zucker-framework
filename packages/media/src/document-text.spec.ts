// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { DocumentTextExtractor, executeDocumentCommand, validateDocumentZip, type DocumentTextOptions, type DocumentTextPorts } from './document-text';

const options: DocumentTextOptions = {
  maxOcrPages: 2, minTextCharacters: 10, maxInputPixels: 1000, imageMaxDimension: 100,
  zip: { maxEntries: 2, maxEntryBytes: 100, maxTotalBytes: 150 },
  languages: 'eng', pageSegmentationModes: [3, 6], rasterDpi: 72,
  commandTimeoutMs: 2000, commandMaxBuffer: 10000,
};
function ports() {
  const parser = { getText: vi.fn(async () => ({ text: 'original text', total: 2, pages: [{ num: 1, text: 'original text' }, { num: 2, text: '' }] })), destroy: vi.fn(async () => {}) };
  const p: DocumentTextPorts = {
    pdf: () => parser, docx: vi.fn(async () => 'original Word text'), zipEntries: () => [],
    image: vi.fn(async () => Buffer.from('png')), office: vi.fn(async () => Buffer.from('pdf')),
    execute: vi.fn(async (file) => ({ stdout: file === 'tesseract' ? 'recognized image text' : '' })),
  };
  return { p, parser };
}

describe('DocumentTextExtractor', () => {
  it('preserves mixed PDF text, OCRs only sparse pages and removes temporary files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'media-test-'));
    try {
      const { p, parser } = ports();
      const result = await new DocumentTextExtractor(p, { ...options, tempRoot: root }).extract(Buffer.from('pdf'), 'pdf');
      expect(result).toEqual({ text: 'original text\n\nrecognized image text', pageCount: 2, ocrUsed: true });
      expect(p.execute).toHaveBeenCalledTimes(2);
      expect(p.execute).toHaveBeenCalledWith('pdftoppm', expect.arrayContaining(['-scale-to', '31']), expect.any(Object));
      expect(parser.destroy).toHaveBeenCalledTimes(1);
      expect(await readdir(root)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('bounds OCR pages before starting commands', async () => {
    const { p } = ports();
    await expect(new DocumentTextExtractor(p, { ...options, minTextCharacters: 100, maxOcrPages: 1 }).extract(Buffer.alloc(0), 'pdf')).rejects.toThrow('page limit');
    expect(p.execute).not.toHaveBeenCalled();
  });
  it('cancels, destroys parser once and preserves cancellation reason', async () => {
    const { p, parser } = ports(); const controller = new AbortController();
    parser.getText.mockImplementation(async () => { controller.abort(new Error('cancelled')); throw new Error('parser ended'); });
    await expect(new DocumentTextExtractor(p, options).extract(Buffer.alloc(0), 'pdf', controller.signal)).rejects.toThrow('cancelled');
    expect(parser.destroy).toHaveBeenCalledTimes(1);
    expect(p.execute).not.toHaveBeenCalled();
  });
  it('uses fallback OCR, passes pixel limit to decoder and cleans up on command failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'media-failure-'));
    try {
      const { p } = ports();
      p.execute = vi.fn().mockResolvedValueOnce({ stdout: 'x' }).mockRejectedValueOnce(new Error('ocr failed'));
      await expect(new DocumentTextExtractor(p, { ...options, tempRoot: root }).extract(Buffer.from('image'), 'image')).rejects.toThrow('ocr failed');
      expect(p.image).toHaveBeenCalledWith(Buffer.from('image'), { limitInputPixels: 1000, maxDimension: 100 });
      expect(p.execute).toHaveBeenCalledTimes(2);
      expect(await readdir(root)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('uses text DOCX without Office and routes sparse Word through Office', async () => {
    const { p } = ports(); const extractor = new DocumentTextExtractor(p, options);
    expect((await extractor.extract(Buffer.alloc(0), 'docx')).ocrUsed).toBe(false);
    expect(p.office).not.toHaveBeenCalled();
    p.docx = async () => '';
    await extractor.extract(Buffer.alloc(0), 'docx');
    expect(p.office).toHaveBeenCalledWith(Buffer.alloc(0), 'docx', undefined);
  });
  it('rejects pre-aborted input without invoking parsers', async () => {
    const { p } = ports(); p.pdf = vi.fn(p.pdf);
    const c = new AbortController(); c.abort(new Error('stop'));
    await expect(new DocumentTextExtractor(p, options).extract(Buffer.alloc(0), 'pdf', c.signal)).rejects.toThrow('stop');
    expect(p.pdf).not.toHaveBeenCalled();
  });
  it('validates ZIP before docx parsing', async () => {
    const { p } = ports(); p.zipEntries = () => [{ size: 500, crc: 0, encrypted: false, method: 0, compressed: () => Buffer.alloc(0) }];
    await expect(new DocumentTextExtractor(p, options).extract(Buffer.alloc(0), 'docx')).rejects.toMatchObject({ code: 'INVALID_ZIP' });
    expect(p.docx).not.toHaveBeenCalled();
  });
});

describe('bounded ZIP validation', () => {
  it('checks standard IEEE CRC-32 vectors without trusting archive metadata', () => {
    for (const [text, crc] of [['123456789', 0xcbf43926], ['', 0]] as const) {
      const data = Buffer.from(text);
      expect(() => validateDocumentZip([{ size: data.length, crc, encrypted: false, method: 0, compressed: () => data }], options.zip)).not.toThrow();
    }
  });
  const entry = (data: Buffer) => ({ size: data.length, crc: crc32(data), encrypted: false, method: 8, compressed: () => deflateRawSync(data) });
  it('accepts compressed members and rejects aggregate/count/checksum/encryption violations', () => {
    expect(() => validateDocumentZip([entry(Buffer.alloc(20))], options.zip)).not.toThrow();
    expect(() => validateDocumentZip([entry(Buffer.alloc(80)), entry(Buffer.alloc(80))], options.zip)).toThrow();
    expect(() => validateDocumentZip(Array(3).fill(entry(Buffer.alloc(1))), options.zip)).toThrow('entry limit');
    expect(() => validateDocumentZip([{ ...entry(Buffer.alloc(20)), crc: 1 }], options.zip)).toThrow('checksum');
    expect(() => validateDocumentZip([{ ...entry(Buffer.alloc(20)), encrypted: true }], options.zip)).toThrow();
  });
  it('bounds inflation even when advertised uncompressed size is forged', () => {
    expect(() => validateDocumentZip([{ ...entry(Buffer.alloc(10000)), size: 1 }], options.zip)).toThrow();
  });
});

describe('real local execFile port (no provider)', () => {
  it('captures output without shell interpolation and reports executable failure', async () => {
    expect(await executeDocumentCommand(process.execPath, ['-e', 'console.log(process.argv[1])', '$(not-a-command)'], { timeout: 2000, maxBuffer: 1000 })).toEqual({ stdout: '$(not-a-command)\n' });
    await expect(executeDocumentCommand('/nonexistent-media-test', [], { timeout: 2000, maxBuffer: 1000 })).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('handles already-aborted signals, command timeout and output limits', async () => {
    const c = new AbortController(); c.abort(new Error('preabort'));
    await expect(executeDocumentCommand(process.execPath, ['-e', 'console.log(1)'], { signal: c.signal, timeout: 2000, maxBuffer: 1000 })).rejects.toThrow('preabort');
    await expect(executeDocumentCommand(process.execPath, ['-e', 'setInterval(() => {}, 100)'], { timeout: 30, maxBuffer: 1000 })).rejects.toThrow();
    await expect(executeDocumentCommand(process.execPath, ['-e', 'console.log("x".repeat(10000))'], { timeout: 2000, maxBuffer: 10 })).rejects.toThrow();
  });
  it('aborts a real child and waits for close', async () => {
    const c = new AbortController();
    const work = executeDocumentCommand(process.execPath, ['-e', 'setInterval(() => {}, 100)'], { signal: c.signal, timeout: 2000, maxBuffer: 1000 });
    c.abort(new Error('cancel child'));
    await expect(work).rejects.toThrow('cancel child');
  });
});
