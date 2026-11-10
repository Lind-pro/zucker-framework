import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MediaTaskStatus, MediaType } from '../media.interface';
import type { HttpAsyncTaskAdapterConfig } from './http-async-task.config';
import { HttpAsyncTaskConfigError, HttpAsyncTaskMediaProvider } from './http-async-task.provider';

const adapter = (overrides: Partial<HttpAsyncTaskAdapterConfig> = {}): HttpAsyncTaskAdapterConfig => ({
  id: 'synthetic-image',
  mediaType: MediaType.IMAGE,
  models: [{ id: 'img-v1', name: 'Img', mediaType: MediaType.IMAGE }],
  baseUrl: 'https://api.gen.example/v1',
  submit: { path: '/jobs', fields: { prompt: 'input.text.prompt', width: 'input.size.w' }, taskIdPath: 'id' },
  poll: {
    path: '/jobs/{taskId}', statusPath: 'state',
    status: { pending: ['queued'], processing: ['running'], completed: ['done'], failed: ['failed'] },
    outputPath: 'images', progressPath: 'pct',
  },
  ...overrides,
});
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const cfg = { apiKey: 'synthetic-key', modelId: 'img-v1' };

interface Seen { url: string; init: RequestInit }
function recording(reply: (url: string) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  return { seen, fetch: async (url: string, init: RequestInit) => { seen.push({ url, init }); return reply(url); } };
}

describe('HttpAsyncTaskMediaProvider request construction', () => {
  it('writes nested fields, honours PUT and header auth, and never leaks the key into the URL', async () => {
    const t = recording(() => json({ id: 'a1' }));
    const provider = new HttpAsyncTaskMediaProvider(
      adapter({ auth: { type: 'header', name: 'x-api-key' }, submit: { ...adapter().submit, method: 'PUT', body: { input: { keep: 1 } } } }),
      { fetch: t.fetch },
    );
    await provider.generate('a cat', { ...cfg, width: 512 });
    const call = t.seen[0];
    expect(call.url).toBe('https://api.gen.example/v1/jobs');
    expect(call.init.method).toBe('PUT');
    expect(call.init.redirect).toBe('manual');
    const headers = call.init.headers as Headers;
    expect(headers.get('x-api-key')).toBe('synthetic-key');
    expect(headers.get('authorization')).toBeNull();
    expect(JSON.parse(String(call.init.body))).toEqual({ input: { keep: 1, text: { prompt: 'a cat' }, size: { w: 512 } }, model: 'img-v1' });
    expect(call.url).not.toContain('synthetic-key');
  });

  it('uses bearer auth by default and no auth header for auth none', async () => {
    const bearer = recording(() => json({ id: 'a1' }));
    await new HttpAsyncTaskMediaProvider(adapter(), { fetch: bearer.fetch }).generate('p', cfg);
    expect((bearer.seen[0].init.headers as Headers).get('authorization')).toBe('Bearer synthetic-key');
    const none = recording(() => json({ id: 'a1' }));
    await new HttpAsyncTaskMediaProvider(adapter({ auth: { type: 'none' } }), { fetch: none.fetch }).generate('p', { modelId: 'img-v1' });
    expect((none.seen[0].init.headers as Headers).has('authorization')).toBe(false);
  });

  it('does not mutate the configured submit body between calls', async () => {
    const t = recording(() => json({ id: 'a1' }));
    const body = { input: { fixed: true } };
    const provider = new HttpAsyncTaskMediaProvider(adapter({ submit: { ...adapter().submit, body } }), { fetch: t.fetch });
    await provider.generate('one', cfg);
    await provider.generate('two', cfg);
    expect(body).toEqual({ input: { fixed: true } });
    expect(JSON.parse(String(t.seen[1].init.body)).input.text.prompt).toBe('two');
  });
});

describe('HttpAsyncTaskMediaProvider SSRF and path safety', () => {
  it.each([
    'https://evil.example/v1',
    'https://api.gen.example:8443/v1',
    'http://api.gen.example/v1',
    'https://api.gen.example.evil.example/v1',
    'https://user@api.gen.example/v1',
  ])('refuses a per-call baseURL override %s before any request', async (baseURL) => {
    const t = recording(() => json({ id: 'a1' }));
    const provider = new HttpAsyncTaskMediaProvider(adapter(), { fetch: t.fetch });
    await expect(provider.generate('p', { ...cfg, baseURL })).rejects.toBeInstanceOf(HttpAsyncTaskConfigError);
    await expect(provider.getTaskStatus('t', { ...cfg, baseURL })).rejects.toBeInstanceOf(HttpAsyncTaskConfigError);
    expect(t.seen).toHaveLength(0);
  });

  it('keeps every request on the configured host whatever the task id contains', async () => {
    const t = recording(() => json({ state: 'running' }));
    const provider = new HttpAsyncTaskMediaProvider(adapter(), { fetch: t.fetch });
    for (const id of ['a/b', 'a?x=1', 'a#frag', '@evil.example', '//evil.example', 'a%2f..%2f', 'a\\b']) {
      await provider.getTaskStatus(id, cfg);
    }
    for (const { url } of t.seen) {
      const parsed = new URL(url);
      expect(parsed.host).toBe('api.gen.example');
      expect(parsed.pathname.startsWith('/v1/jobs/')).toBe(true);
      expect(parsed.search).toBe('');
      expect(parsed.hash).toBe('');
    }
  });

  it.each(['..', '.'])('does not let task id %s climb out of the poll path', async (id) => {
    const t = recording(() => json({ state: 'running' }));
    const provider = new HttpAsyncTaskMediaProvider(adapter(), { fetch: t.fetch });
    await provider.getTaskStatus(id, cfg).catch(() => undefined);
    for (const { url } of t.seen) expect(new URL(url).pathname.startsWith('/v1/jobs/')).toBe(true);
  });

  it.each(['', ' ', 'a b', 'a\nb', 'x'.repeat(257), 'café'])('rejects invalid task id %j', async (id) => {
    const provider = new HttpAsyncTaskMediaProvider(adapter(), { fetch: async () => json({}) });
    await expect(provider.getTaskStatus(id, cfg)).rejects.toThrow(TypeError);
  });

  it('does not follow redirects: a 302 to a private host is a provider error and one request only', async () => {
    const t = recording(() => new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/latest' } }));
    const provider = new HttpAsyncTaskMediaProvider(adapter(), { fetch: t.fetch });
    await expect(provider.generate('p', cfg)).rejects.toMatchObject({ status: 302 });
    await expect(provider.getTaskStatus('t', cfg)).rejects.toMatchObject({ status: 302 });
    expect(t.seen).toHaveLength(2);
    expect(t.seen.every((call) => call.init.redirect === 'manual')).toBe(true);
  });

  it.each([
    ['__proto__.polluted'], ['constructor.prototype.polluted'], ['a.prototype.b'], ['a..b'], [''], ['.a'],
  ])('refuses field path %j in every position', (path) => {
    const base = adapter();
    for (const make of [
      () => adapter({ submit: { ...base.submit, taskIdPath: path } }),
      () => adapter({ submit: { ...base.submit, fields: { prompt: path } } }),
      () => adapter({ poll: { ...base.poll, statusPath: path } }),
      () => adapter({ poll: { ...base.poll, outputPath: path } }),
      () => adapter({ poll: { ...base.poll, progressPath: path } }),
      () => adapter({ poll: { ...base.poll, errorPath: path } }),
      () => adapter({ poll: { ...base.poll, outputItemUrlField: path } }),
    ]) {
      expect(() => new HttpAsyncTaskMediaProvider(make())).toThrow(HttpAsyncTaskConfigError);
    }
  });

  it('never pollutes Object.prototype and ignores inherited or __proto__ response keys', async () => {
    const hostile = '{"id":"ok","__proto__":{"polluted":"yes","id":"evil"},"state":"done","images":["https://cdn.gen.example/a.png"],"constructor":{"prototype":{"polluted":"yes"}}}';
    const t = recording(() => new Response(hostile, { status: 200 }));
    const provider = new HttpAsyncTaskMediaProvider(adapter(), { fetch: t.fetch });
    const submitted = await provider.generate('p', cfg);
    expect(submitted.taskId).toBe('ok');
    await provider.getTaskStatus('ok', cfg);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // Inherited properties are not readable through a config path.
    const inherited = new HttpAsyncTaskMediaProvider(
      adapter({ submit: { ...adapter().submit, taskIdPath: 'toString' } }), { fetch: async () => json({}) },
    );
    await expect(inherited.generate('p', cfg)).rejects.toMatchObject({ status: 502 });
  });

  it('does not let a body template with __proto__ pollute through field writes', async () => {
    const t = recording(() => json({ id: 'x' }));
    const body = JSON.parse('{"__proto__":{"polluted":1},"input":{"text":"not-an-object"}}') as Record<string, unknown>;
    const provider = new HttpAsyncTaskMediaProvider(adapter({ submit: { ...adapter().submit, body } }), { fetch: t.fetch });
    await provider.generate('p', cfg);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('HttpAsyncTaskMediaProvider response limits', () => {
  const stream = (chunks: string[], headers: Record<string, string> = {}) => {
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
      start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); },
    }), { status: 200, headers });
  };

  it('rejects a body over 1 MiB by content-length without reading it', async () => {
    const provider = new HttpAsyncTaskMediaProvider(adapter(), { fetch: async () => stream(['{}'], { 'content-length': String(1024 * 1024 + 1) }) });
    await expect(provider.getTaskStatus('t', cfg)).rejects.toMatchObject({ status: 502, message: expect.stringContaining('too large') });
  });

  it('rejects an undeclared body that streams past 1 MiB, and accepts exactly 1 MiB of JSON', async () => {
    const filler = 'a'.repeat(1024 * 1024);
    const over = new HttpAsyncTaskMediaProvider(adapter(), { fetch: async () => stream(['{"state":"running","x":"', filler, '"}']) });
    await expect(over.getTaskStatus('t', cfg)).rejects.toMatchObject({ status: 502 });
    const head = '{"state":"running","x":"';
    const tail = '"}';
    const exact = 'a'.repeat(1024 * 1024 - head.length - tail.length);
    const ok = new HttpAsyncTaskMediaProvider(adapter(), { fetch: async () => stream([head + exact + tail]) });
    await expect(ok.getTaskStatus('t', cfg)).resolves.toMatchObject({ status: MediaTaskStatus.PROCESSING });
  });

  it('honours a smaller maxResponseBytes and validates it', async () => {
    const provider = new HttpAsyncTaskMediaProvider(adapter({ maxResponseBytes: 16 }), { fetch: async () => stream(['{"state":"running","pad":"0123456789"}']) });
    await expect(provider.getTaskStatus('t', cfg)).rejects.toMatchObject({ status: 502 });
    for (const maxResponseBytes of [0, -1, 1.5, Number.NaN]) {
      expect(() => new HttpAsyncTaskMediaProvider(adapter({ maxResponseBytes }))).toThrow(HttpAsyncTaskConfigError);
    }
  });

  it('caps outputs at 16 and drops non-https, credentialed and oversized URLs', async () => {
    const urls = [
      ...Array.from({ length: 20 }, (_, i) => `https://cdn.gen.example/${i}.png`),
    ];
    const provider = new HttpAsyncTaskMediaProvider(adapter(), { fetch: async () => json({ state: 'done', images: urls }) });
    const done = await provider.getTaskStatus('t', cfg);
    expect(done.outputs).toHaveLength(16);
    const mixed = new HttpAsyncTaskMediaProvider(adapter(), {
      fetch: async () => json({ state: 'done', images: ['http://x.example/a.png', 'https://u:p@x.example/a.png', 'javascript:alert(1)', 'data:image/png;base64,AA', `https://x.example/${'a'.repeat(4100)}`, 42, null, 'https://ok.example/a.png'] }),
    });
    const result = await mixed.getTaskStatus('t', cfg);
    expect(result.outputs?.map((o) => o.url)).toEqual(['https://ok.example/a.png']);
  });

  it('clamps progress to 0..100 and scales it; a completed task without outputs fails', async () => {
    const progress = (pct: unknown, scale?: number) => new HttpAsyncTaskMediaProvider(
      adapter({ poll: { ...adapter().poll, progressScale: scale } }), { fetch: async () => json({ state: 'running', pct }) },
    ).getTaskStatus('t', cfg);
    expect((await progress(250)).progress).toBe(100);
    expect((await progress(-5)).progress).toBe(0);
    expect((await progress(0.5, 1)).progress).toBe(50);
    expect((await progress('50')).progress).toBeUndefined();
    expect((await progress(Number.NaN)).progress).toBeUndefined();
    const empty = new HttpAsyncTaskMediaProvider(adapter(), { fetch: async () => json({ state: 'done', images: [] }) });
    expect(await empty.getTaskStatus('t', cfg)).toMatchObject({ status: MediaTaskStatus.FAILED });
  });

  it('truncates provider error messages and never echoes an unknown status value', async () => {
    const failed = new HttpAsyncTaskMediaProvider(adapter({ poll: { ...adapter().poll, errorPath: 'msg' } }), { fetch: async () => json({ state: 'failed', msg: 'e'.repeat(900) }) });
    expect((await failed.getTaskStatus('t', cfg)).error).toHaveLength(500);
    const unknown = new HttpAsyncTaskMediaProvider(adapter(), { fetch: async () => json({ state: 'SECRET-PROVIDER-TEXT' }) });
    const result = await unknown.getTaskStatus('t', cfg);
    expect(result.status).toBe(MediaTaskStatus.FAILED);
    expect(result.error).not.toContain('SECRET');
  });
});

describe('HttpAsyncTaskMediaProvider verifier variants', () => {
  const secret = 'synthetic-callback-secret';
  const provider = new HttpAsyncTaskMediaProvider(adapter(), { fetch: async () => json({}) });
  const body = JSON.stringify({ id: 'job-7', state: 'done', images: ['https://cdn.gen.example/a.png'] });

  it('verifies sha512 base64 signatures over Uint8Array bodies, header names case-insensitively', async () => {
    const verifier = provider.createCallbackVerifier({ secret, signatureHeader: 'X-Sig', algorithm: 'sha512', encoding: 'base64' });
    const sig = createHmac('sha512', secret).update(body).digest('base64');
    const result = await verifier.verify(new TextEncoder().encode(body), { 'x-SIG': sig });
    expect(result?.providerTaskId).toBe('job-7');
    expect(result?.task).toMatchObject({ status: MediaTaskStatus.COMPLETED });
    const wrongAlgorithm = createHmac('sha256', secret).update(body).digest('base64');
    await expect(verifier.verify(body, { 'x-sig': wrongAlgorithm })).resolves.toBeNull();
    await expect(verifier.verify(body, { 'x-sig': '***not base64***' })).resolves.toBeNull();
    await expect(verifier.verify(body, { 'x-sig': sig.slice(0, -4) })).resolves.toBeNull();
  });

  it('parseTask:false returns only the task id, even for a completed payload', async () => {
    const verifier = provider.createCallbackVerifier({ secret, signatureHeader: 'x-sig', parseTask: false });
    const sig = createHmac('sha256', secret).update(body).digest('hex');
    expect(await verifier.verify(body, { 'x-sig': sig })).toEqual({ providerTaskId: 'job-7' });
  });

  it('returns only the task id when the payload carries no status', async () => {
    const verifier = provider.createCallbackVerifier({ secret, signatureHeader: 'x-sig' });
    const raw = JSON.stringify({ id: 99 });
    const sig = createHmac('sha256', secret).update(raw).digest('hex');
    expect(await verifier.verify(raw, { 'x-sig': sig })).toEqual({ providerTaskId: '99' });
  });

  it('never throws: empty, oversized, non-JSON, wrong-secret and hostile inputs yield null', async () => {
    const verifier = provider.createCallbackVerifier({ secret, signatureHeader: 'x-sig' });
    const sign = (raw: string, key = secret) => createHmac('sha256', key).update(raw).digest('hex');
    await expect(verifier.verify('', { 'x-sig': sign('') })).resolves.toBeNull();
    const big = JSON.stringify({ id: 'a', pad: 'x'.repeat(1024 * 1024) });
    await expect(verifier.verify(big, { 'x-sig': sign(big) })).resolves.toBeNull();
    await expect(verifier.verify('nope', { 'x-sig': sign('nope') })).resolves.toBeNull();
    await expect(verifier.verify(body, { 'x-sig': sign(body, 'another-secret-value-1') })).resolves.toBeNull();
    await expect(verifier.verify(body, {} as never)).resolves.toBeNull();
    await expect(verifier.verify(body, undefined as never)).resolves.toBeNull();
    const proto = JSON.stringify({ id: 'a', ['__proto__']: { id: 'b' } });
    await expect(verifier.verify(proto, { 'x-sig': sign(proto) })).resolves.toEqual({ providerTaskId: 'a' });
  });

  it('refuses invalid verifier options', () => {
    for (const options of [
      { secret, signatureHeader: 'bad header' },
      { secret, signatureHeader: 'x-sig', timestampHeader: 'bad header' },
      { secret, signatureHeader: 'x-sig', taskIdPath: '__proto__.id' },
    ]) {
      expect(() => provider.createCallbackVerifier(options)).toThrow(HttpAsyncTaskConfigError);
    }
  });

  it('rejects timestamps in the future beyond tolerance and non-numeric timestamps', async () => {
    const now = 1_800_000_000_000;
    const verifier = provider.createCallbackVerifier({ secret, signatureHeader: 'x-sig', timestampHeader: 'x-ts', now: () => now, toleranceSeconds: 60 });
    const sign = (ts: string) => createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
    const future = String(now / 1000 + 61);
    await expect(verifier.verify(body, { 'x-sig': sign(future), 'x-ts': future })).resolves.toBeNull();
    await expect(verifier.verify(body, { 'x-sig': sign('1e9'), 'x-ts': '1e9' })).resolves.toBeNull();
    const ok = String(now / 1000 + 59);
    expect((await verifier.verify(body, { 'x-sig': sign(ok), 'x-ts': ok }))?.providerTaskId).toBe('job-7');
  });
});
