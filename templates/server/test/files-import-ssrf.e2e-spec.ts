import { describe, expect, it, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import { createPublicFetch, type HostResolver } from '@zucker-framework/core';
import { FilesImportService } from '../src/files/files-import.service';
import type { FilesService } from '../src/files/files.service';
import type { FilesOptions } from '../src/files/files.config';
import type { FilesTransferOptions } from '../src/files/files-transfer.config';

/** FilesImportService with the production transport (core createPublicFetch) and a fake resolver; no database, no network. */
const dns = (table: Record<string, string[]>): HostResolver => async (host) => {
  const answers = table[host];
  if (!answers) throw new Error('ENOTFOUND');
  return answers.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};
const lookups: string[] = [];
const resolver = dns({
  'files.example.invalid': ['10.0.0.8'],
  'rebind.example.invalid': ['93.184.216.34', '127.0.0.1'],
  'meta.example.invalid': ['169.254.169.254'],
  'mapped.example.invalid': ['::ffff:7f00:1'],
  'nat64.example.invalid': ['64:ff9b::a00:1'],
  'ula.example.invalid': ['fd00::1'],
});
const counting: HostResolver = async (host) => { lookups.push(host); return resolver(host); };
const hosts = ['files.example.invalid', 'rebind.example.invalid', 'meta.example.invalid', 'mapped.example.invalid', 'nat64.example.invalid', 'ula.example.invalid', 'nx.example.invalid'];
const options: FilesTransferOptions = { downloadTtlSeconds: 60, importAllowedHosts: hosts, importTimeoutMs: 500 };
const limits = { maxObjectBytes: 2048 } as FilesOptions;

function service() {
  const upload = vi.fn();
  const files = { validateRequestKey: vi.fn(), upload } as unknown as FilesService;
  const fetchPublic = createPublicFetch({ allowedProtocols: ['https:'], allowedPorts: [443], resolve: counting });
  return { upload, importer: new FilesImportService(files, limits, options, fetchPublic) };
}
const code = async (work: Promise<unknown>) => {
  const error = await work.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(HttpException);
  return { status: (error as HttpException).getStatus(), body: (error as HttpException).getResponse() as { code: string; message: string } };
};

describe('FilesImportService with the SSRF-vetting transport', () => {
  it.each(hosts.slice(0, 6))('refuses %s (allow-listed host resolving to a non-public answer) with 403 and never uploads', async (host) => {
    const { importer, upload } = service();
    const result = await code(importer.import('owner-1', 'key-1', { url: `https://${host}/a.pdf?sig=SYNTHETIC_PRIVATE` }));
    expect(result.status).toBe(403);
    expect(result.body.code).toBe('FILE_IMPORT_SOURCE_FORBIDDEN');
    expect(JSON.stringify(result.body)).not.toMatch(/10\.0\.0|127\.0\.0|169\.254|SYNTHETIC_PRIVATE|fd00/); // fixed message, no address or URL echo
    expect(upload).not.toHaveBeenCalled();
  });

  it('resolves before connecting, once per request, so the vetted answer is the only one used', async () => {
    const { importer } = service(); lookups.length = 0;
    await code(importer.import('owner-1', 'key-1', { url: 'https://rebind.example.invalid/a.pdf' }));
    expect(lookups).toEqual(['rebind.example.invalid']);
  });

  it('a resolution failure is a retryable 503, not a policy 403', async () => {
    const { importer, upload } = service();
    const result = await code(importer.import('owner-1', 'key-1', { url: 'https://nx.example.invalid/a.pdf' }));
    expect(result.status).toBe(503); expect(result.body.code).toBe('FILE_IMPORT_FAILED');
    expect(upload).not.toHaveBeenCalled();
  });

  it('static host policy still applies first: non-listed hosts, IP literals, http and ports are 403 without a lookup', async () => {
    const { importer } = service(); lookups.length = 0;
    for (const url of ['https://other.example.invalid/a', 'https://127.0.0.1/a', 'https://[::1]/a', 'http://files.example.invalid/a', 'https://files.example.invalid:8443/a', 'https://u:p@files.example.invalid/a'])
      expect((await code(importer.import('owner-1', 'key-1', { url }))).body.code, url).toBe('FILE_IMPORT_SOURCE_FORBIDDEN');
    expect(lookups).toEqual([]);
  });

  it('import is disabled (403 FILE_IMPORT_DISABLED) when no hosts are allow-listed, even with a public-looking URL', async () => {
    const files = { validateRequestKey: vi.fn(), upload: vi.fn() } as unknown as FilesService;
    const importer = new FilesImportService(files, limits, { ...options, importAllowedHosts: [] }, createPublicFetch({ resolve: counting }));
    const result = await code(importer.import('owner-1', 'key-1', { url: 'https://files.example.invalid/a' }));
    expect(result).toMatchObject({ status: 403, body: { code: 'FILE_IMPORT_DISABLED' } });
  });
});
