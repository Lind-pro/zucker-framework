import { BadRequestException, HttpException, Inject, Injectable } from '@nestjs/common';
import { assertAllowedOutboundUrl } from '@zucker-framework/core';
import { FILES_OPTIONS, type FilesOptions } from './files.config';
import { FILES_IMPORT_FETCH, FILES_TRANSFER_OPTIONS, type FilesImportFetch, type FilesTransferOptions } from './files-transfer.config';
import { FilesService } from './files.service';
function failure(code: string, message: string, status: number): HttpException { return new HttpException({ code, message }, status); }
@Injectable()
export class FilesImportService {
  constructor(private readonly files: FilesService, @Inject(FILES_OPTIONS) private readonly limits: FilesOptions,
    @Inject(FILES_TRANSFER_OPTIONS) private readonly options: FilesTransferOptions, @Inject(FILES_IMPORT_FETCH) private readonly fetch: FilesImportFetch) {}
  async import(ownerId: string, key: string | undefined, body: unknown) {
    this.files.validateRequestKey(key);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(field => !['url', 'fileName'].includes(field))) throw new BadRequestException('Invalid file import request');
    const input = body as { url?: unknown; fileName?: unknown };
    if (typeof input.url !== 'string' || input.url.length > 4096 || input.url !== input.url.trim() || /[\u0000-\u0020\u007f]/.test(input.url)
      || input.fileName !== undefined && (typeof input.fileName !== 'string' || !input.fileName || input.fileName.length > 255)) throw new BadRequestException('Invalid file import request');
    if (!this.options.importAllowedHosts.length) throw failure('FILE_IMPORT_DISABLED', 'URL import is not enabled for this server', 403);
    let source: URL;
    try {
      source = assertAllowedOutboundUrl(input.url, { allowedHosts: this.options.importAllowedHosts, allowedProtocols: ['https:'], allowedPorts: [443], allowCredentials: false, allowIpLiterals: false });
      if (source.hash) throw new Error();
    } catch { throw failure('FILE_IMPORT_SOURCE_FORBIDDEN', 'This file source is not allowed', 403); }
    const bytes = await this.download(source.href);
    return this.files.upload(ownerId, key, { originalname: typeof input.fileName === 'string' ? input.fileName : 'import.bin', buffer: bytes });
  }
  private async download(url: string): Promise<Buffer> {
    const controller = new AbortController(); let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const unavailable = () => failure('FILE_IMPORT_FAILED', 'File source could not be read; retry the original request or inspect its saved file', 503);
    const timeout = setTimeout(() => controller.abort(), this.options.importTimeoutMs);
    const aborted = new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(unavailable()), { once: true }));
    // Keep an owned rejection handler even when cleanup aborts after the final read completes.
    void aborted.catch(() => {});
    try {
      const response = await Promise.race([this.fetch(url, { method: 'GET', redirect: 'manual', credentials: 'omit', signal: controller.signal }), aborted]);
      if (response.redirected || response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => {}); throw failure('FILE_IMPORT_REDIRECT_BLOCKED', 'Redirected file sources are not allowed', 400);
      }
      if (!response.ok || !response.body) { void response.body?.cancel().catch(() => {}); throw unavailable(); }
      const header = response.headers.get('content-length');
      if (header !== null && (!/^\d+$/.test(header) || !Number.isSafeInteger(Number(header)))) { void response.body.cancel().catch(() => {}); throw unavailable(); }
      if (header !== null && Number(header) > this.limits.maxObjectBytes) { void response.body.cancel().catch(() => {}); throw failure('FILE_IMPORT_TOO_LARGE', 'Imported file exceeds the configured size limit', 413); }
      reader = response.body.getReader(); const chunks: Buffer[] = []; let length = 0;
      for (;;) {
        const chunk = await Promise.race([reader.read(), aborted]); if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > this.limits.maxObjectBytes) throw failure('FILE_IMPORT_TOO_LARGE', 'Imported file exceeds the configured size limit', 413);
        chunks.push(Buffer.from(chunk.value));
      }
      if (!length) throw unavailable();
      return Buffer.concat(chunks, length);
    } catch (error) { if (error instanceof HttpException) throw error; throw unavailable(); }
    finally { clearTimeout(timeout); controller.abort(); if (reader) void reader.cancel().catch(() => {}); }
  }
}
