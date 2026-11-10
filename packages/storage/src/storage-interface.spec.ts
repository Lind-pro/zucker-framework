import { describe, expect, it } from 'vitest';
import { isFileDenied } from './storage.interface';

describe('isFileDenied', () => {
  const pngOnly = { allowExtensions: ['png'], allowMimeTypes: ['image/png'] };

  it('requires every configured allow-list to pass', () => {
    expect(isFileDenied('shell.php', 'image/png', pngOnly)).toBe(true);
    expect(isFileDenied('x.png', 'text/html', pngOnly)).toBe(true);
    expect(isFileDenied('x.png', 'image/png', pngOnly)).toBe(false);
    expect(isFileDenied('x.PNG', 'IMAGE/PNG; charset=binary', { allowExtensions: ['PNG'], allowMimeTypes: ['image/png'] })).toBe(false);
    expect(isFileDenied('x.png', undefined, pngOnly)).toBe(true);
  });

  it('evaluates deny-lists before allow-lists', () => {
    expect(isFileDenied('shell.php', undefined, { allowExtensions: ['png'], denyMimeTypes: ['text/html'] })).toBe(true);
    expect(isFileDenied('x.png', 'text/html', { allowExtensions: ['png'], denyMimeTypes: ['text/html'] })).toBe(true);
    expect(isFileDenied('x.txt', 'text/plain', { denyExtensions: ['TXT'] })).toBe(true);
  });

  it('checks the sniffed MIME type against the same lists', () => {
    expect(isFileDenied('x.png', 'image/png', pngOnly, undefined, { sniffedMimeType: 'text/html' })).toBe(true);
    expect(isFileDenied('x.png', 'image/png', pngOnly, undefined, { sniffedMimeType: 'image/png' })).toBe(false);
    expect(isFileDenied('x.bin', 'application/octet-stream', { denyMimeTypes: ['application/x-msdownload'] }, undefined, {
      sniffedMimeType: 'application/x-msdownload',
    })).toBe(true);
  });

  it('blocks DANGEROUS_EXTENSIONS by default unless explicitly allowed', () => {
    expect(isFileDenied('a.exe', undefined, {})).toBe(true);
    expect(isFileDenied('a.EXE', undefined, {})).toBe(true);
    expect(isFileDenied('chart.svg', 'image/svg+xml', {})).toBe(true);
    expect(isFileDenied('chart.svg', 'image/svg+xml', { allowExtensions: ['svg'] })).toBe(false);
    expect(isFileDenied('chart.svg', 'image/svg+xml', { allowDangerousExtensions: ['svg'] })).toBe(false);
    expect(isFileDenied('report.pdf', 'application/pdf', {})).toBe(false);
  });

  it('rejects trailing dots and spaces', () => {
    expect(isFileDenied('shell.php.', undefined, {})).toBe(true);
    expect(isFileDenied('shell.png ', undefined, { allowExtensions: ['png'] })).toBe(true);
  });
});

describe('DANGEROUS_EXTENSIONS additions', () => {
  it.each(['html', 'htm', 'xhtml', 'shtml', 'mjs', 'hta', 'swf', 'xml'])('denies .%s by default', (ext) => {
    expect(isFileDenied(`file.${ext}`, undefined, {})).toBe(true);
    expect(isFileDenied(`FILE.${ext.toUpperCase()}`, undefined, {})).toBe(true);
  });

  it('allowDangerousExtensions: ["html"] allows .html but not other dangerous types', () => {
    expect(isFileDenied('page.html', 'text/html', { allowDangerousExtensions: ['html'] })).toBe(false);
    expect(isFileDenied('page.htm', 'text/html', { allowDangerousExtensions: ['html'] })).toBe(true);
    expect(isFileDenied('a.exe', undefined, { allowDangerousExtensions: ['html'] })).toBe(true);
  });
});
