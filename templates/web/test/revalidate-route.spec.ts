// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { POST } from '../src/app/api/revalidate/route';
import { REVALIDATE_MAX_BODY_BYTES, signRevalidation } from '../src/features/content/revalidate';

const { revalidateTag } = vi.hoisted(() => ({ revalidateTag: vi.fn() }));
vi.mock('next/cache', () => ({ revalidateTag }));
const secret = 'synthetic-revalidation-test-secret-0123456789';
beforeEach(() => {
  vi.stubEnv('REVALIDATE_SECRET', secret);
  revalidateTag.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function streamedRequest(chunks: Uint8Array[], headers?: Record<string, string>) {
  let reads = 0;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[reads++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel,
  }, { highWaterMark: 0 });
  const request = new Request('http://localhost/api/revalidate', { method: 'POST', body, headers, duplex: 'half' } as RequestInit);
  return { request, cancel, reads: () => reads };
}

it.each([undefined, { 'content-length': '1' }])('bounds actual unsigned body bytes with missing/false Content-Length (%j)', async headers => {
  const fixture = streamedRequest(Array.from({ length: 256 }, () => new Uint8Array(4096)), headers);
  const response = await POST(fixture.request);
  expect(response.status).toBe(413);
  expect(fixture.reads()).toBe(5);
  expect(fixture.cancel).toHaveBeenCalledTimes(1);
  expect(revalidateTag).not.toHaveBeenCalled();
});

it('cancels an oversized declared body before reading any chunks', async () => {
  const fixture = streamedRequest([new Uint8Array(4096)], { 'content-length': String(REVALIDATE_MAX_BODY_BYTES + 1) });
  expect((await POST(fixture.request)).status).toBe(413);
  expect(fixture.reads()).toBe(0);
  expect(fixture.cancel).toHaveBeenCalledTimes(1);
});

it('accepts an exactly-at-limit signed payload and preserves its raw bytes across chunks', async () => {
  const body = JSON.stringify({ tags: ['content:boundary'] }).padEnd(REVALIDATE_MAX_BODY_BYTES, ' ');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const encoded = new TextEncoder().encode(body);
  const fixture = streamedRequest([encoded.slice(0, 7), encoded.slice(7, 29), encoded.slice(29)], {
    'x-revalidate-timestamp': timestamp,
    'x-revalidate-signature': signRevalidation(secret, timestamp, body),
  });
  expect((await POST(fixture.request)).status).toBe(200);
  expect(revalidateTag).toHaveBeenCalledExactlyOnceWith('content:boundary', { expire: 0 });
  expect(fixture.cancel).not.toHaveBeenCalled();
});

it('rejects a body one byte over the limit even with syntactically valid authentication headers', async () => {
  const fixture = streamedRequest([new Uint8Array(REVALIDATE_MAX_BODY_BYTES), new Uint8Array(1)], {
    'x-revalidate-timestamp': String(Math.floor(Date.now() / 1000)), 'x-revalidate-signature': `v1=${'0'.repeat(64)}`,
  });
  expect((await POST(fixture.request)).status).toBe(413);
  expect(fixture.cancel).toHaveBeenCalledTimes(1);
});

it('keeps invalid signatures rejected and the disabled endpoint at 404', async () => {
  const request = () => new Request('http://localhost/api/revalidate', { method: 'POST', body: '{"tags":["content"]}' });
  expect((await POST(request())).status).toBe(401);
  vi.stubEnv('REVALIDATE_SECRET', '');
  expect((await POST(request())).status).toBe(404);
  expect(revalidateTag).not.toHaveBeenCalled();
});
