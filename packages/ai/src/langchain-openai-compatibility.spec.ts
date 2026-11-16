// @vitest-environment node
import { BaseLanguageModel } from '@langchain/core/language_models/base';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createLangChainChatModel,
  type LangChainChatModelOptions,
} from './langchain-model-builder';

// The configured OpenAI transport does not intercept SDK auxiliary requests.
// Fail the test even when an SDK catches a rejected ambient fetch and falls back.
const unexpectedFetch = vi.fn<typeof globalThis.fetch>(async input => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  // AbortError prevents the SDK's retry backoff from outliving test cleanup.
  throw new DOMException(`Unexpected network request in SDK compatibility test: ${url}`, 'AbortError');
});
beforeEach(() => {
  unexpectedFetch.mockClear();
  vi.stubGlobal('fetch', unexpectedFetch);
  // Streaming invoke estimates tokens via a lazily downloaded tokenizer even
  // when provider usage is present. This suite tests transport/structured output,
  // not tokenizer accuracy; include the SDK instances cloned by structured output.
  vi.spyOn(BaseLanguageModel.prototype, 'getNumTokens').mockResolvedValue(1);
});
afterEach(() => {
  try {
    expect(unexpectedFetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

const answer = { ok: true };
const usage = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 };
const defaults = {
  protocol: 'openai-compatible',
  apiKey: 'synthetic-test-key',
  model: 'gpt-6.1-sol',
  temperature: 0.7,
  maxTokens: 321,
  maxRetries: 0,
  timeoutMs: 1000,
} satisfies LangChainChatModelOptions;

function transport() {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (...args) => {
    const request = new Request(...args);
    const body = await request.json() as Record<string, unknown>;
    requests.push({ url: request.url, body });
    const common = { id: 'synthetic', created: 0, model: body.model };
    if (body.stream) {
      const packets = [
        { choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify(answer) }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage },
      ];
      return new Response(packets.map(packet => `data: ${JSON.stringify({
        ...common, object: 'chat.completion.chunk', ...packet,
      })}\n\n`).join('') + 'data: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return Response.json({ ...common, object: 'chat.completion', usage,
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(answer) }, finish_reason: 'stop' }],
    });
  });
  return { fetch, requests };
}

function expectOfficialRequest(body: Record<string, unknown>) {
  expect(body.max_completion_tokens).toBe(defaults.maxTokens);
  expect(body).not.toHaveProperty('max_tokens');
  expect(body).not.toHaveProperty('temperature');
  expect(body).not.toHaveProperty('thinking');
}

describe('official OpenAI request compatibility through the installed SDK', () => {
  it('normalizes requests using the default fetch transport', async () => {
    const f = transport();
    vi.stubGlobal('fetch', f.fetch);
    try {
      const model = await createLangChainChatModel(defaults);
      await model.invoke('Return JSON');
      expect(f.fetch).toHaveBeenCalledTimes(1);
      expectOfficialRequest(f.requests[0].body);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([undefined, 'https://api.openai.com/v1', 'https://api.openai.com/v1/'])(
    'preserves GPT-6 output limits for endpoint %s and the explicit fetch transport', async baseURL => {
      const f = transport();
      const model = await createLangChainChatModel({ ...defaults, baseURL,
        proxyUrl: 'http://synthetic-proxy.test:8080', fetch: f.fetch });
      const result = await model.invoke('Return JSON');
      expect(result.content).toBe(JSON.stringify(answer));
      expect(result.usage_metadata).toMatchObject({ input_tokens: 7, output_tokens: 3, total_tokens: 10 });
      expect(f.fetch).toHaveBeenCalledTimes(1);
      expect(f.requests[0].url).toBe('https://api.openai.com/v1/chat/completions');
      expectOfficialRequest(f.requests[0].body);
    },
  );

  it('preserves streaming and usage without restoring legacy parameters', async () => {
    const f = transport();
    const model = await createLangChainChatModel({ ...defaults, streaming: true, fetch: f.fetch });
    const chunks = [];
    for await (const chunk of await model.stream('Return JSON')) chunks.push(chunk);
    expect(chunks.map(chunk => chunk.content).join('')).toBe(JSON.stringify(answer));
    expect(chunks.at(-1)?.usage_metadata).toMatchObject({ input_tokens: 7, output_tokens: 3, total_tokens: 10 });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.requests[0].body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expectOfficialRequest(f.requests[0].body);
  });

  it.each(['jsonMode', 'jsonSchema'] as const)(
    'keeps compatibility through withStructuredOutput using %s', async method => {
      const f = transport();
      const model = await createLangChainChatModel({ ...defaults, streaming: true, fetch: f.fetch,
        thinking: { enabled: true, reasoningEffort: 'high' } });
      const structured = model.withStructuredOutput(z.object({ ok: z.boolean() }), {
        method, name: 'synthetic_answer',
      });
      await expect(structured.invoke('Return JSON')).resolves.toEqual(answer);
      expect(f.fetch).toHaveBeenCalledTimes(1);
      expectOfficialRequest(f.requests[0].body);
      expect(f.requests[0].body.reasoning_effort).toBe('high');
      expect(f.requests[0].body.response_format).toMatchObject(method === 'jsonMode'
        ? { type: 'json_object' }
        : { type: 'json_schema', json_schema: { name: 'synthetic_answer', schema: {
          type: 'object', properties: { ok: { type: 'boolean' } },
        } } });
    },
  );

  it('retains temperature for a legacy official model with the completion token limit', async () => {
    const f = transport();
    const model = await createLangChainChatModel({ ...defaults, model: 'gpt-4o', fetch: f.fetch });
    await model.invoke('Return JSON');
    expect(f.requests[0].body).toMatchObject({ temperature: 0.7, max_completion_tokens: 321 });
    expect(f.requests[0].body).not.toHaveProperty('max_tokens');
  });

  it('retains temperature when GPT-6.1 Terra explicitly disables reasoning', async () => {
    const f = transport();
    const model = await createLangChainChatModel({ ...defaults, model: 'gpt-6.1-terra', fetch: f.fetch,
      thinking: { enabled: true, reasoningEffort: 'none' } });
    await model.invoke('Return JSON');
    expect(f.requests[0].body).toMatchObject({
      reasoning_effort: 'none', temperature: 0.7, max_completion_tokens: 321,
    });
    expect(f.requests[0].body).not.toHaveProperty('thinking');
    expect(f.requests[0].body).not.toHaveProperty('max_tokens');
  });

  it('does not add a retry when maxRetries is zero', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({
      error: { message: 'synthetic provider unavailable', type: 'server_error' },
    }, { status: 500 }));
    const model = await createLangChainChatModel({ ...defaults, fetch });
    await expect(model.invoke('Return JSON')).rejects.toThrow('synthetic provider unavailable');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('propagates the caller abort to an in-flight fetch without retrying', async () => {
    let dispatched!: () => void;
    const started = new Promise<void>(resolve => { dispatched = resolve; });
    let requestSignal: AbortSignal | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(async (...args) => {
      requestSignal = new Request(...args).signal;
      dispatched();
      return new Promise<Response>((_resolve, reject) => {
        requestSignal!.addEventListener('abort', () => reject(new DOMException('Request aborted', 'AbortError')), { once: true });
      });
    });
    const model = await createLangChainChatModel({ ...defaults, fetch });
    const controller = new AbortController();
    const rejected = expect(model.invoke('Return JSON', { signal: controller.signal })).rejects.toThrow(/abort/i);
    await started;
    controller.abort();
    await rejected;
    expect(requestSignal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('other OpenAI-compatible endpoints', () => {
  it.each([
    ['https://api.deepseek.com/v1', 'deepseek-chat'],
    ['https://private-gateway.test/v1', 'gpt-6.1-sol'],
  ])('preserves the existing vendor request at %s', async (baseURL, modelId) => {
    const f = transport();
    const model = await createLangChainChatModel({ ...defaults, model: modelId, baseURL,
      thinking: { enabled: false }, fetch: f.fetch });
    await model.invoke('Return JSON');
    expect(f.requests[0].body).toMatchObject({
      max_tokens: 321, temperature: 0.7, thinking: { type: 'disabled' },
    });
    expect(f.requests[0].body).not.toHaveProperty('max_completion_tokens');
  });
});
