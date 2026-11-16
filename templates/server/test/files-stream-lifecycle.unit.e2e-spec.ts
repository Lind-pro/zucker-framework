import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { FilesService } from '../src/files/files.service';

async function openStream(body = Buffer.from('synthetic private file')) {
  const upstream = new PassThrough();
  const asset = { id: 'synthetic-file', state: 'ready', size: body.length, objectKey: 'synthetic',
    sha256: createHash('sha256').update(body).digest('hex') };
  const service = Object.create(FilesService.prototype) as FilesService;
  Object.assign(service, {
    assets: { inspect: async () => asset }, options: { maxObjectBytes: 1 },
    manager: { download: async () => ({ stream: upstream, size: body.length }) },
  });
  const opened = await service.open('synthetic-user', asset.id);
  if (!('stream' in opened)) throw new Error('Expected streaming read');
  return { upstream, stream: opened.stream, body };
}

describe('private download stream lifecycle', () => {
  it('closes the storage read when the response is cancelled', async () => {
    const { upstream, stream } = await openStream();
    // A response adapter may destroy the body without supplying an error on disconnect.
    stream.on('error', () => {});
    stream.destroy();
    await new Promise(resolve => setImmediate(resolve));
    expect(upstream.destroyed).toBe(true);
  });

  it('closes the storage read when it exceeds the recorded length', async () => {
    const { upstream, stream, body } = await openStream();
    const failure = new Promise<Error>(resolve => stream.once('error', resolve));
    upstream.write(Buffer.alloc(body.length + 1));
    expect((await failure).message).toContain('CONTENT_UNAVAILABLE');
    expect(upstream.destroyed).toBe(true);
  });

  it('propagates a storage failure to the returned stream', async () => {
    const { upstream, stream } = await openStream();
    const failure = new Promise<Error>(resolve => stream.once('error', resolve));
    const error = new Error('synthetic storage failure');
    upstream.destroy(error);
    expect(await failure).toBe(error);
    expect(stream.destroyed).toBe(true);
  });

  it('delivers every byte of a valid object', async () => {
    const { upstream, stream, body } = await openStream();
    upstream.end(body);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(body);
    expect(upstream.destroyed).toBe(true);
  });

  it('withholds the last chunk of an object with a mismatched digest', async () => {
    const { upstream, stream, body } = await openStream();
    upstream.end(Buffer.alloc(body.length));
    const received: Buffer[] = [];
    await expect((async () => {
      for await (const chunk of stream) received.push(Buffer.from(chunk));
    })()).rejects.toThrow('CONTENT_UNAVAILABLE');
    expect(Buffer.concat(received).length).toBeLessThan(body.length);
    expect(upstream.destroyed).toBe(true);
  });
});
