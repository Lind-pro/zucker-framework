import { PayloadTooLargeException } from '@nestjs/common';
import type { Request } from 'express';
import type { Readable } from 'node:stream';

export interface BoundedMemoryStorageOptions {
  /** Total file bytes per request, not per file. Default 200 MiB. */
  maxBytes?: number;
  createLimitError?: (maxBytes: number) => Error;
  decodeFilename?: (name: string) => string;
}

export interface MemoryUploadFile {
  originalname: string;
  stream: Readable;
  buffer?: Buffer;
}

/** Decode Busboy's Latin-1 representation without corrupting already-decoded Unicode. */
export function decodeMultipartFilename(name: string): string {
  if ([...name].some((character) => character.charCodeAt(0) > 255)) return name;
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  return decoded.includes('\ufffd') ? name : decoded;
}

/** Structurally compatible with Multer StorageEngine; no Multer runtime dependency. */
export function boundedMemoryStorage(options: BoundedMemoryStorageOptions = {}) {
  const maxBytes = options.maxBytes ?? 200 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError('maxBytes must be a positive safe integer');
  const received = new WeakMap<object, number>();
  const limitError = () => options.createLimitError?.(maxBytes) ??
    new PayloadTooLargeException(`Total uploaded file bytes exceed ${maxBytes}`);
  return {
    _handleFile(req: Request, file: MemoryUploadFile,
      callback: (error: Error | null, info?: { buffer: Buffer; size: number }) => void): void {
      const chunks: Buffer[] = [];
      let size = 0;
      let finished = false;
      const cleanup = () => {
        req.off('aborted', onAbort);
        file.stream.off('data', onData);
        file.stream.off('end', onEnd);
        file.stream.off('limit', onLimit);
      };
      const fail = (error: Error) => {
        if (finished) return;
        finished = true;
        chunks.length = 0;
        cleanup();
        // Multer must finish draining the multipart parser, even after rejection.
        file.stream.resume();
        callback(error);
      };
      const onAbort = () => fail(new Error('Upload request aborted'));
      const onLimit = () => fail(limitError());
      const onData = (value: Buffer | string) => {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        size += chunk.length;
        const total = (received.get(req) ?? 0) + chunk.length;
        received.set(req, total);
        if (total > maxBytes) { fail(limitError()); return; }
        chunks.push(chunk);
      };
      const onEnd = () => {
        if (finished) return;
        finished = true;
        cleanup();
        const buffer = Buffer.concat(chunks, size);
        chunks.length = 0;
        callback(null, { buffer, size });
      };
      file.stream.on('error', fail); // Consume late errors without invoking callback twice.
      file.stream.once('close', () => { if (!finished) fail(new Error('Upload stream closed prematurely')); });
      file.stream.once('end', onEnd);
      file.stream.once('limit', onLimit);
      req.once('aborted', onAbort);
      try {
        file.originalname = (options.decodeFilename ?? decodeMultipartFilename)(file.originalname);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (req.aborted) { onAbort(); return; }
      if ((received.get(req) ?? 0) > maxBytes) { onLimit(); return; }
      file.stream.on('data', onData);
    },
    _removeFile(_req: Request, file: { buffer?: Buffer }, callback: (error: Error | null) => void): void {
      delete file.buffer;
      callback(null);
    },
  };
}
