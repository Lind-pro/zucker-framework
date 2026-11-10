// @vitest-environment node
import { readFileSync } from 'node:fs';
import { FAKE_PNG_BASE64 } from '@zucker-framework/ai/testing';
import { normalizeProviderResult } from './ai-task.service';
import { pollDelayMs } from './backoff';
import { AITaskOutputRejectedError, AITaskValidationError } from './errors';
import { sniffMediaType } from './media-content';
import { downloadOutput } from './rehost';
import { AI_TASKS_POSTGRESQL_SCHEMA } from './schema';
import { validateSubmitCommand } from './validation';

const PNG = Buffer.from(FAKE_PNG_BASE64, 'base64');
const base = {
  ownerId: 'user-1', kind: 'image' as const, providerId: 'fake-media', model: 'fake-image',
  input: { prompt: 'cat' }, idempotencyKey: 'abcdefgh12',
};

describe('ai-tasks pure contracts', () => {
  it('keeps the shipped SQL asset identical to the exported schema', () => {
    expect(readFileSync(new URL('../assets/ai-tasks.postgresql.sql', import.meta.url), 'utf8')).toBe(AI_TASKS_POSTGRESQL_SCHEMA);
  });

  it('refuses credential/transport options and unknown command keys', () => {
    expect(validateSubmitCommand(base).input).toEqual({ prompt: 'cat' });
    for (const options of [{ apiKey: 'x' }, { baseURL: 'x' }, { callbackUrl: 'x' }, { model: 'x' }, { nested: { a: 1 } }]) {
      expect(() => validateSubmitCommand({ ...base, input: { prompt: 'cat', options: options as never } })).toThrow(AITaskValidationError);
    }
    expect(() => validateSubmitCommand({ ...base, extra: 1 } as never)).toThrow(AITaskValidationError);
    expect(() => validateSubmitCommand({ ...base, kind: 'text' as never })).toThrow(AITaskValidationError);
    expect(() => validateSubmitCommand({ ...base, input: { prompt: ' ' } })).toThrow(AITaskValidationError);
  });

  it('backs off exponentially up to the cap', () => {
    expect([0, 1, 2, 3, 10].map((n) => pollDelayMs(n, { initialDelayMs: 1000, maxDelayMs: 5000 }))).toEqual([1000, 2000, 4000, 5000, 5000]);
  });

  it('normalises sync results and async task states', () => {
    expect(normalizeProviderResult({ url: 'https://x.test/a.png' })).toEqual({ state: 'succeeded', outputs: [{ url: 'https://x.test/a.png' }] });
    expect(normalizeProviderResult({ taskId: 't', status: 'PROCESSING', progress: 40 })).toEqual({ state: 'pending', providerTaskId: 't', progress: 40 });
    expect(normalizeProviderResult({ taskId: 't', status: 'COMPLETED', result: { base64: 'x' } })).toEqual({ state: 'succeeded', outputs: [{ base64: 'x' }] });
    expect(normalizeProviderResult({ taskId: 't', status: 'FAILED', error: 'raw provider text' })).toEqual({ state: 'failed' });
  });

  it('sniffs content and enforces size/type limits on download', async () => {
    expect(sniffMediaType(PNG)).toBe('image/png');
    const signal = new AbortController().signal;
    const ok = await downloadOutput({ base64: FAKE_PNG_BASE64 }, { fetch: vi.fn(), maxBytes: 1024, allowedContentTypes: ['image/png'], signal });
    expect(ok).toMatchObject({ contentType: 'image/png', bytes: PNG.length });
    const svg = async () => new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>', { status: 200 });
    await expect(downloadOutput({ url: 'https://x.test/a.svg' }, { fetch: svg, maxBytes: 1024, allowedContentTypes: ['image/png'], signal }))
      .rejects.toBeInstanceOf(AITaskOutputRejectedError);
    const big = async () => new Response(Buffer.alloc(4096), { status: 200 });
    await expect(downloadOutput({ url: 'https://x.test/a.png' }, { fetch: big, maxBytes: 1024, allowedContentTypes: ['image/png'], signal }))
      .rejects.toMatchObject({ reason: 'too-large' });
    const redirect = async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } });
    await expect(downloadOutput({ url: 'https://x.test/a.png' }, { fetch: redirect, maxBytes: 1024, allowedContentTypes: ['image/png'], signal }))
      .rejects.toMatchObject({ reason: 'redirect' });
  });
});
