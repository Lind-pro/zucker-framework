import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkContentDirectory, formatContentCheck } from '../src/content/content-check';

/** `content:check` (WP 4.2): database-free validation of content/ files with field paths. */
describe('content check', () => {
  it('accepts the shipped starter content', async () => {
    const report = await checkContentDirectory(resolve('content'));
    expect(report.issues).toEqual([]);
    expect(report.valid).toBeGreaterThanOrEqual(14);
  });

  it('reports a broken block file with its field path, bad names and a missing directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zf-content-check-'));
    try {
      mkdirSync(join(root, 'pages'));
      const home = JSON.parse(readFileSync(resolve('content/pages/home.en.json'), 'utf8')) as { document: { blocks: Array<Record<string, unknown>> } };
      (home.document.blocks[1].items as Array<Record<string, unknown>>)[0].title = '';
      writeFileSync(join(root, 'pages/home.en.json'), JSON.stringify(home));
      writeFileSync(join(root, 'pages/About.txt'), 'synthetic');
      writeFileSync(join(root, 'pages/pricing.en.md'), '---\ntitle: Reserved\npublishedAt: 2026-01-01\n---\nSynthetic.\n');
      const report = await checkContentDirectory(root);
      expect(report.valid).toBe(0);
      expect(report.issues).toEqual(expect.arrayContaining([
        { source: 'pages/home.en.json', message: expect.stringContaining('(blocks.1.items.0.title)') },
        { source: 'pages/About.txt', message: expect.stringContaining('File name') },
        { source: 'pages/pricing.en.md', message: expect.stringContaining('not a valid page slug') },
      ]));
      const lines = formatContentCheck(report);
      expect(lines.at(-1)).toMatch(/0 valid, 3 invalid/);
      expect(lines.join('\n')).not.toContain('Accounts and sign-in');
      expect((await checkContentDirectory(join(root, 'missing'))).issues).toEqual([{ source: '.', message: 'Content directory not found' }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
