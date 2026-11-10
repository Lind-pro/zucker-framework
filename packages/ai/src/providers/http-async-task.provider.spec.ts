import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { OutboundUrlRejectedError } from '@zucker-framework/core';
import { MediaTaskStatus, MediaType, isAudioGenerationProvider } from '../media.interface';
import type { HttpAsyncTaskAdapterConfig } from './http-async-task.config';
import { HttpAsyncTaskConfigError, HttpAsyncTaskMediaProvider } from './http-async-task.provider';

const adapter = (overrides: Partial<HttpAsyncTaskAdapterConfig> = {}): HttpAsyncTaskAdapterConfig => ({
  id: 'synthetic-music',
  mediaType: MediaType.AUDIO,
  models: [{ id: 'song-v1', name: 'Song', mediaType: MediaType.AUDIO }],
  baseUrl: 'https://api.music.example/v2',
  submit: {
    path: '/generate',
    body: { mode: 'custom' },
    fields: { lyrics: 'input.lyrics', instrumental: 'input.instrumental', callbackUrl: 'callBackUrl' },
    taskIdPath: 'data.taskId',
  },
  poll: {
    path: '/tasks/{taskId}?detail=1',
    statusPath: 'data.status',
    status: { pending: ['QUEUED'], processing: ['RUNNING'], completed: ['SUCCESS'], failed: ['ERROR'] },
    outputPath: 'data.tracks',
    outputItemUrlField: 'audioUrl',
    progressPath: 'data.progress',
    progressScale: 1,
    errorPath: 'data.message',
  },
  costPerTask: 0.2,
  ...overrides,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const base = { apiKey: 'synthetic-key', modelId: 'song-v1' };

describe('HttpAsyncTaskMediaProvider configuration', () => {
  it.each([
    ['http base', { baseUrl: 'http://api.music.example' }],
    ['credentials', { baseUrl: 'https://user:pw@api.music.example' }],
    ['IP literal', { baseUrl: 'https://10.0.0.1' }],
    ['localhost', { baseUrl: 'https://localhost' }],
    ['non-default port', { baseUrl: 'https://api.music.example:8443' }],
  ])('refuses %s', (_label, overrides) => {
    expect(() => new HttpAsyncTaskMediaProvider(adapter(overrides))).toThrow(HttpAsyncTaskConfigError);
  });

  it('accepts an explicitly allowed port', () => {
    expect(() => new HttpAsyncTaskMediaProvider(adapter({ baseUrl: 'https://api.music.example:8443', allowedPorts: [8443] }))).not.toThrow();
  });

  it.each(['//evil.example/x', 'generate', '/../admin', '/a/./b', '/a\\b'])('refuses submit path %s', (path) => {
    expect(() => new HttpAsyncTaskMediaProvider(adapter({ submit: { ...adapter().submit, path } }))).toThrow(HttpAsyncTaskConfigError);
  });

  it('refuses prototype field paths, a poll path without {taskId} and mismatched models', () => {
    expect(() => new HttpAsyncTaskMediaProvider(adapter({ submit: { ...adapter().submit, fields: { prompt: '__proto__.x' } } }))).toThrow(HttpAsyncTaskConfigError);
    expect(() => new HttpAsyncTaskMediaProvider(adapter({ poll: { ...adapter().poll, path: '/tasks' } }))).toThrow(HttpAsyncTaskConfigError);
    expect(() => new HttpAsyncTaskMediaProvider(adapter({ models: [{ id: 'x', name: 'x', mediaType: MediaType.IMAGE }] }))).toThrow(HttpAsyncTaskConfigError);
  });
});

describe('HttpAsyncTaskMediaProvider submit and poll (recorded fixtures)', () => {
  it('maps the submit body, auth and task id, then polls to completion with every output', async () => {
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === 'POST') return json({ code: 0, data: { taskId: 'tk_1' } });
      return json({ data: { status: 'SUCCESS', progress: 1, tracks: [{ audioUrl: 'https://cdn.music.example/a.mp3' }, { audioUrl: 'https://cdn.music.example/b.mp3' }] } });
    });
    const provider = new HttpAsyncTaskMediaProvider(adapter(), { fetch });
    expect(isAudioGenerationProvider(provider)).toBe(true);

    const submitted = await provider.generate('a calm piano song', { ...base, lyrics: 'la la', instrumental: false, callbackUrl: 'https://app.example/cb' });
    expect(submitted).toEqual({ taskId: 'tk_1', status: MediaTaskStatus.PENDING, provider: 'synthetic-music' });
    const [submitUrl, submitInit] = fetch.mock.calls[0];
    expect(submitUrl).toBe('https://api.music.example/v2/generate');
    expect(new Headers(submitInit.headers).get('authorization')).toBe('Bearer synthetic-key');
    expect(JSON.parse(String(submitInit.body))).toEqual({
      mode: 'custom', prompt: 'a calm piano song', model: 'song-v1',
      input: { lyrics: 'la la', instrumental: false }, callBackUrl: 'https://app.example/cb',
    });

    const done = await provider.getTaskStatus('tk/1', base);
    expect(fetch.mock.calls[1][0]).toBe('https://api.music.example/v2/tasks/tk%2F1?detail=1');
    expect(done.status).toBe(MediaTaskStatus.COMPLETED);
    expect(done.progress).toBe(100);
    expect(done.outputs?.map((output) => output.url)).toEqual(['https://cdn.music.example/a.mp3', 'https://cdn.music.example/b.mp3']);
    expect(done.result).toMatchObject({ mediaType: MediaType.AUDIO, cost: 0.2, model: 'song-v1' });
    expect(done.outputs?.[1].cost).toBe(0);
  });

  it('maps processing, provider failure, unknown status and unsafe outputs', async () => {
    const answers = [
      { data: { status: 'RUNNING', progress: 0.4 } },
      { data: { status: 'ERROR', message: 'content policy' } },
      { data: { status: 'MYSTERY' } },
      { data: { status: 'SUCCESS', tracks: [{ audioUrl: 'http://cdn.music.example/a.mp3' }, { audioUrl: 'file:///etc/passwd' }] } },
    ];
    const provider = new HttpAsyncTaskMediaProvider(adapter(), { fetch: async () => json(answers.shift()) });
    expect(await provider.getTaskStatus('t', base)).toMatchObject({ status: MediaTaskStatus.PROCESSING, progress: 40 });
    expect(await provider.getTaskStatus('t', base)).toMatchObject({ status: MediaTaskStatus.FAILED, error: 'content policy' });
    const unknown = await provider.getTaskStatus('t', base);
    expect(unknown.status).toBe(MediaTaskStatus.FAILED);
    expect(unknown.error).not.toContain('MYSTERY');
    expect(await provider.getTaskStatus('t', base)).toMatchObject({ status: MediaTaskStatus.FAILED, error: expect.stringContaining('https output') });
  });

  it('parses a submit response that already carries the task state', async () => {
    const provider = new HttpAsyncTaskMediaProvider(adapter(), {
      fetch: async () => json({ data: { taskId: 7, status: 'QUEUED' } }),
    });
    expect(await provider.generate('x', base)).toMatchObject({ taskId: '7', status: MediaTaskStatus.PENDING });
  });

  it('turns HTTP errors, non-JSON, missing task ids and oversized bodies into provider errors', async () => {
    const answers: Response[] = [
      json({ error: 'nope' }, 401),
      new Response('<html>', { status: 200 }),
      json({ data: {} }),
      new Response('x'.repeat(64), { status: 200 }),
    ];
    const provider = new HttpAsyncTaskMediaProvider(adapter({ maxResponseBytes: 32 }), { fetch: async () => answers.shift()! });
    await expect(provider.generate('x', base)).rejects.toMatchObject({ name: 'ProviderHttpError', status: 401 });
    await expect(provider.generate('x', base)).rejects.toMatchObject({ status: 502 });
    await expect(provider.generate('x', base)).rejects.toThrow('task id');
    await expect(provider.generate('x', base)).rejects.toThrow('too large');
  });

  it('refuses a per-call baseURL that points elsewhere, unknown models and a missing key', async () => {
    const fetch = vi.fn(async () => json({ data: { taskId: 'a' } }));
    const provider = new HttpAsyncTaskMediaProvider(adapter(), { fetch });
    await expect(provider.generate('x', { ...base, baseURL: 'https://evil.example' })).rejects.toThrow(HttpAsyncTaskConfigError);
    await expect(provider.generate('x', { ...base, modelId: 'other' })).rejects.toThrow('Unknown model');
    await expect(provider.generate('x', { ...base, apiKey: '' })).rejects.toThrow('API key');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('propagates cancellation to the in-flight request', async () => {
    let seen: AbortSignal | undefined;
    const provider = new HttpAsyncTaskMediaProvider(adapter(), {
      fetch: (_url, init) => new Promise<Response>((_resolve, reject) => {
        seen = init.signal ?? undefined;
        seen?.addEventListener('abort', () => reject(seen?.reason), { once: true });
      }),
    });
    const controller = new AbortController();
    const pending = provider.getTaskStatus('t', { ...base, signal: controller.signal });
    controller.abort(new Error('caller cancelled'));
    await expect(pending).rejects.toThrow('caller cancelled');
    expect(seen?.aborted).toBe(true);
  });

  it('uses the public-address transport by default (private DNS answer refused, no connection)', async () => {
    const provider = new HttpAsyncTaskMediaProvider(adapter(), { resolve: async () => [{ address: '10.0.0.8', family: 4 }] });
    await expect(provider.getTaskStatus('t', base)).rejects.toBeInstanceOf(OutboundUrlRejectedError);
  });
});

describe('HttpAsyncTaskMediaProvider callback verifier', () => {
  const secret = 'synthetic-callback-secret';
  const provider = new HttpAsyncTaskMediaProvider(adapter(), { fetch: async () => json({}) });
  const now = 1_800_000_000_000;
  const verifier = provider.createCallbackVerifier({
    secret, signatureHeader: 'X-Signature', signaturePrefix: 'sha256=', timestampHeader: 'X-Timestamp', now: () => now,
  });
  const body = JSON.stringify({ data: { taskId: 'tk_9', status: 'SUCCESS', tracks: [{ audioUrl: 'https://cdn.music.example/z.mp3' }] } });
  const sign = (timestamp: string, raw = body) => `sha256=${createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex')}`;
  const ts = String(now / 1000);

  it('accepts an authentic callback and parses the task from it', async () => {
    const result = await verifier.verify(Buffer.from(body), { 'x-signature': sign(ts), 'x-timestamp': ts });
    expect(result?.providerTaskId).toBe('tk_9');
    expect(result?.task).toMatchObject({ status: MediaTaskStatus.COMPLETED, outputs: [{ url: 'https://cdn.music.example/z.mp3' }] });
  });

  it.each([
    ['bad signature', { 'x-signature': sign(ts, '{}'), 'x-timestamp': ts }],
    ['missing signature', { 'x-timestamp': ts }],
    ['missing timestamp', { 'x-signature': sign(ts) }],
    ['stale timestamp', { 'x-signature': sign(String(now / 1000 - 301)), 'x-timestamp': String(now / 1000 - 301) }],
    ['repeated header', { 'x-signature': [sign(ts), sign(ts)], 'x-timestamp': ts }],
    ['wrong prefix', { 'x-signature': sign(ts).replace('sha256=', ''), 'x-timestamp': ts }],
  ])('returns null for %s', async (_label, headers) => {
    await expect(verifier.verify(body, headers)).resolves.toBeNull();
  });

  it('returns null for a signed body without a task id', async () => {
    const raw = JSON.stringify({ data: { status: 'SUCCESS' } });
    await expect(verifier.verify(raw, { 'x-signature': sign(ts, raw), 'x-timestamp': ts })).resolves.toBeNull();
  });

  it('exposes only the claimed task id as an unauthenticated hint', () => {
    expect(verifier.hint?.(body, {})).toBe('tk_9');
    expect(verifier.hint?.('not json', {})).toBeNull();
    expect(verifier.hint?.(JSON.stringify({ data: { taskId: 'bad id!' } }), {})).toBeNull();
  });

  it('refuses short secrets', () => {
    expect(() => provider.createCallbackVerifier({ secret: 'short', signatureHeader: 'x-sig' })).toThrow(HttpAsyncTaskConfigError);
  });
});
