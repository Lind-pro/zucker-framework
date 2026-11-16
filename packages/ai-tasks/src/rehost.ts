import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { AITaskOutputRejectedError } from './errors';
import { sniffMediaType } from './media-content';
import type { AIMediaResultLike } from './ports';

export type OutputFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface DownloadOutputOptions {
  fetch: OutputFetch;
  maxBytes: number;
  allowedContentTypes: readonly string[];
  signal: AbortSignal;
}

export interface DownloadedOutput {
  body: Buffer;
  contentType: string;
  sha256: string;
  bytes: number;
}

/**
 * Buffered variant (hosts whose OutputStorePort has no `putStream`): reads one provider output (URL or
 * inline base64) into memory with a hard byte cap, then accepts it
 * only when the sniffed type is allowed for the task kind. The `fetch` must be SSRF-safe (the service
 * default is core's `createPublicFetch`: https/443 only, public pinned addresses, no redirects).
 */
export async function downloadOutput(output: AIMediaResultLike, options: DownloadOutputOptions): Promise<DownloadedOutput> {
  let body: Buffer;
  if (typeof output.url === 'string' && output.url) {
    body = await fetchBounded(output.url, options);
  } else if (typeof output.base64 === 'string' && output.base64) {
    body = decodeInline(output.base64, options.maxBytes);
  } else {
    throw new AITaskOutputRejectedError('missing');
  }
  if (body.length === 0) throw new AITaskOutputRejectedError('empty');
  if (body.length > options.maxBytes) throw new AITaskOutputRejectedError('too-large');
  const contentType = sniffMediaType(body);
  if (!contentType || !options.allowedContentTypes.includes(contentType)) throw new AITaskOutputRejectedError('content-type');
  return { body, contentType, sha256: createHash('sha256').update(body).digest('hex'), bytes: body.length };
}

async function fetchBounded(url: string, options: DownloadOutputOptions): Promise<Buffer> {
  const response = await options.fetch(url, { method: 'GET', redirect: 'manual', signal: options.signal });
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw new AITaskOutputRejectedError(response.status >= 300 && response.status < 400 ? 'redirect' : 'status');
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > options.maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new AITaskOutputRejectedError('too-large');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const onAbort = () => { void reader.cancel(options.signal.reason).catch(() => undefined); };
  options.signal.addEventListener('abort', onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      options.signal.throwIfAborted();
      const { done, value } = await reader.read();
      options.signal.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > options.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new AITaskOutputRejectedError('too-large');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, total);
  } finally {
    options.signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

/** Bytes read before the first byte is handed on: enough for every magic number `sniffMediaType` checks. */
const SNIFF_BYTES = 64;

export type OpenOutputOptions = DownloadOutputOptions;

/**
 * A provider output opened for streaming. The type was sniffed from the first bytes before any byte
 * was handed on; `stream` replays those bytes and then the rest, hashing and counting as it flows and
 * failing with `AITaskOutputRejectedError('too-large')` as soon as the cap is exceeded.
 */
export interface OpenedOutput {
  contentType: string;
  stream: Readable;
  /** Digest of everything that passed through; `complete` only once the source ended within the cap. */
  digest(): { sha256: string; bytes: number; complete: boolean };
  /** The cap/content rejection raised while streaming, if any (a reason to fail, never to retry). */
  rejection(): AITaskOutputRejectedError | undefined;
  /** A transport error of the source while streaming (retryable download failure), if any. */
  sourceError(): unknown;
  /** Stops reading the source (idempotent). */
  cancel(): Promise<void>;
}

/**
 * Opens one provider output (URL or inline base64) for streaming storage, without buffering it whole.
 * The `fetch` must be SSRF-safe (the service default is core's `createPublicFetch`). Inline base64 is
 * decoded in memory but bounded by `maxBytes` before decoding.
 */
export async function openOutput(output: AIMediaResultLike, options: OpenOutputOptions): Promise<OpenedOutput> {
  let source: AsyncIterator<Uint8Array>;
  let cancelSource: () => Promise<void>;
  if (typeof output.url === 'string' && output.url) {
    const response = await options.fetch(output.url, { method: 'GET', redirect: 'manual', signal: options.signal });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new AITaskOutputRejectedError(response.status >= 300 && response.status < 400 ? 'redirect' : 'status');
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > options.maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new AITaskOutputRejectedError('too-large');
    }
    if (!response.body) throw new AITaskOutputRejectedError('empty');
    const reader = response.body.getReader();
    const onAbort = () => { void reader.cancel(options.signal.reason).catch(() => undefined); };
    options.signal.addEventListener('abort', onAbort, { once: true });
    source = { next: async () => {
      options.signal.throwIfAborted();
      const { done, value } = await reader.read();
      options.signal.throwIfAborted();
      if (done) options.signal.removeEventListener('abort', onAbort);
      return done ? { done: true, value: undefined } : { done: false, value };
    } };
    cancelSource = async () => {
      options.signal.removeEventListener('abort', onAbort);
      await reader.cancel().catch(() => undefined);
    };
  } else if (typeof output.base64 === 'string' && output.base64) {
    const body = decodeInline(output.base64, options.maxBytes);
    let sent = false;
    source = { next: async () => (sent ? { done: true, value: undefined } : (sent = true, { done: false, value: body })) };
    cancelSource = async () => undefined;
  } else {
    throw new AITaskOutputRejectedError('missing');
  }

  // Read the sniff window first; nothing is handed on before the type is accepted.
  const prefix: Uint8Array[] = [];
  let prefixBytes = 0;
  let ended = false;
  try {
    while (prefixBytes < SNIFF_BYTES) {
      const next = await source.next();
      if (next.done) { ended = true; break; }
      if (!next.value?.byteLength) continue;
      prefix.push(next.value);
      prefixBytes += next.value.byteLength;
      if (prefixBytes > options.maxBytes) throw new AITaskOutputRejectedError('too-large');
    }
  } catch (error) {
    await cancelSource();
    throw error;
  }
  const head = Buffer.concat(prefix.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
  const contentType = sniffMediaType(head);
  if (head.length === 0 || !contentType || !options.allowedContentTypes.includes(contentType)) {
    await cancelSource();
    throw new AITaskOutputRejectedError(head.length === 0 ? 'empty' : 'content-type');
  }

  const hash = createHash('sha256');
  let bytes = 0;
  let complete = false;
  let rejection: AITaskOutputRejectedError | undefined;
  let sourceError: unknown;
  let cancelled = false;
  const cancel = async () => {
    if (cancelled) return;
    cancelled = true;
    await cancelSource();
  };
  const pass = (chunk: Uint8Array): Buffer => {
    bytes += chunk.byteLength;
    if (bytes > options.maxBytes) throw (rejection = new AITaskOutputRejectedError('too-large'));
    const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    hash.update(buffer);
    return buffer;
  };
  async function* flow(): AsyncGenerator<Buffer> {
    try {
      if (head.length) yield pass(head);
      if (!ended) {
        for (;;) {
          let next: IteratorResult<Uint8Array>;
          try {
            next = await source.next();
          } catch (error) {
            sourceError = error;
            throw error;
          }
          if (next.done) break;
          if (next.value?.byteLength) yield pass(next.value);
        }
      }
      complete = true;
    } finally {
      // Normal end, consumer abort or error: never leave the source connection open.
      if (!complete) await cancel();
    }
  }
  let sha256: string | undefined;
  return {
    contentType,
    stream: Readable.from(flow(), { objectMode: false }),
    digest: () => {
      if (complete && sha256 === undefined) sha256 = hash.digest('hex');
      return { sha256: sha256 ?? '', bytes, complete };
    },
    rejection: () => rejection,
    sourceError: () => sourceError,
    cancel,
  };
}

function decodeInline(value: string, maxBytes: number): Buffer {
  const encoded = value.replace(/^data:[^,]*;base64,/, '');
  if (Math.floor((encoded.length * 3) / 4) > maxBytes + 3) throw new AITaskOutputRejectedError('too-large');
  if (!/^[A-Za-z0-9+/=\s]+$/.test(encoded)) throw new AITaskOutputRejectedError('invalid-encoding');
  const body = Buffer.from(encoded, 'base64');
  if (body.length === 0) throw new AITaskOutputRejectedError('empty');
  if (body.length > maxBytes) throw new AITaskOutputRejectedError('too-large');
  return body;
}
