// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AIConfigService } from './config.service';
import { StaticAIConfigSource } from './config-sources/static-config.source';
import { AICallWrapper } from './call-wrapper';
import { NativeAIClient, type NativeAIModel } from './native-port';
import { createNativeAIModel } from './native-providers';

const config = { apiKey: 'synthetic', modelId: 'configured-model', modelRecordId: 'record-a', providerId: 'openai' };
const request = { messages: [{ role: 'user' as const, content: 'synthetic' }] };
const configs = () => new AIConfigService(undefined, [new StaticAIConfigSource({ defaultConfig: config, scenarios: { embed: config } })]);

describe('native call lifecycle', () => {
  it('rejects missing embedding configuration before constructing a provider, including after default caching', async () => {
    const service = configs();
    await service.getScenarioConfig('missing');
    const factory = vi.fn();
    const client = new NativeAIClient(service, new AICallWrapper(), factory);
    await expect(client.embed('missing', ['text'], 2)).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
  });
  it('owns retries once and preserves identity in chat, stream and embedding', async () => {
    const chat = vi.fn().mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 429 })).mockResolvedValue({ content: 'ok', usage: { input: 1, output: 2, total: 3 } });
    const port: NativeAIModel = {
      chat,
      stream: async () => (async function* () { yield { content: 'ok', usage: { input: 1, output: 2, total: 3 } }; })(),
      embed: async () => ({ embeddings: [[1, 2]] }),
    };
    const client = new NativeAIClient(configs(), new AICallWrapper(), async () => port);
    expect(await client.chat('chat', request, { baseDelayMs: 0 })).toMatchObject({ content: 'ok', config: { modelRecordId: 'record-a' } });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(await client.stream('chat', request)).toMatchObject({ content: 'ok', config: { modelRecordId: 'record-a' }, usage: { total: 3 } });
    expect(await client.embed('embed', ['text'], 2)).toMatchObject({ embeddings: [[1, 2]], config: { modelRecordId: 'record-a' } });
  });
  it('clears database identity on explicit model overrides and never exposes credentials', async () => {
    const factory = vi.fn(async () => ({ chat: async () => ({ content: 'ok' }), stream: vi.fn() }));
    const client = new NativeAIClient(configs(), new AICallWrapper(), factory);
    const result = await client.chat('chat', request, { modelId: 'override-model' });
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'override-model', modelRecordId: undefined }));
    expect(result.config).toEqual({ modelId: 'override-model', providerId: 'openai', modelRecordId: undefined });
    expect(result.config).not.toHaveProperty('apiKey');
  });
  it('aborts in-flight calls without retries and rejects malformed embedding responses', async () => {
    const controller = new AbortController();
    const chat = vi.fn(async (_request, signal: AbortSignal) => {
      controller.abort();
      return new Promise<never>((_resolve, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason)); });
    });
    const embed = vi.fn(async () => ({ embeddings: [[NaN]] }));
    const client = new NativeAIClient(configs(), new AICallWrapper(), async () => ({ chat, stream: vi.fn(), embed }));
    await expect(client.chat('chat', request, { signal: controller.signal })).rejects.toThrow();
    expect(chat).toHaveBeenCalledTimes(1);
    await expect(client.embed('embed', ['text'], 2)).rejects.toThrow('invalid embedding');
    expect(embed).toHaveBeenCalledTimes(1);
  });
  it('does not replay a partially consumed stream and closes its iterator', async () => {
    let closed = false;
    const stream = vi.fn(async () => (async function* () {
      try { yield { content: 'partial' }; throw Object.assign(new Error('disconnect'), { status: 503 }); }
      finally { closed = true; }
    })());
    const client = new NativeAIClient(configs(), new AICallWrapper(), async () => ({ chat: vi.fn(), stream }));
    await expect(client.stream('chat', request)).rejects.toThrow('disconnect');
    expect(stream).toHaveBeenCalledTimes(1);
    expect(closed).toBe(true);
  });
  it('fails closed for unsupported proxy configuration instead of silently bypassing it', async () => {
    await expect(createNativeAIModel({ ...config, proxyUrl: 'http://synthetic.test' })).rejects.toThrow('proxy-aware');
    await expect(createNativeAIModel({ ...config, providerId: 'gemini' }, { fetch })).rejects.toThrow('public fetch');
  });
});

describe('native SDK synthetic HTTP wire contracts (no paid calls)', () => {
  let server: Server;
  let base: string;
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      let text = '';
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      const path = req.url ?? '';
      calls.push({ path, body });
      res.setHeader('content-type', 'application/json');
      if (body.model === 'retry-model' || path.includes('/retry-model:')) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: { message: 'synthetic unavailable', type: 'overloaded_error', code: 503, status: 'UNAVAILABLE' } }));
        return;
      }
      if (path.startsWith('/openai')) {
        if (path.endsWith('/embeddings')) res.end(JSON.stringify({ model: body.model, data: [{ index: 0, embedding: [1, 2] }], usage: { prompt_tokens: 2, total_tokens: 2 } }));
        else if (body.stream) {
          res.setHeader('content-type', 'text/event-stream');
          res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hello' } }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }) + '\n\ndata: [DONE]\n\n');
        } else res.end(JSON.stringify({ id: 'synthetic', model: body.model, choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }));
      } else if (path.startsWith('/anthropic')) {
        if (body.stream) {
          res.setHeader('content-type', 'text/event-stream');
          const events = [
            { type: 'message_start', message: { usage: { input_tokens: 2, output_tokens: 0, cache_read_input_tokens: 1 } } },
            { type: 'content_block_delta', index: 0, delta: body.tools ? { type: 'input_json_delta', partial_json: '{"ok":true}' } : { type: 'text_delta', text: 'hello' } },
            { type: 'message_delta', usage: { output_tokens: 3 } },
            { type: 'message_stop' },
          ];
          res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
        } else res.end(JSON.stringify({ id: 'synthetic', model: body.model, content: body.tools ? [{ type: 'text', text: 'ignored preamble' }, { type: 'tool_use', name: 'json_output', input: { ok: true } }] : [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 1 } }));
      } else {
        const result = { modelVersion: 'configured-model', candidates: [{ content: { parts: [{ text: 'hello' }], role: 'model' }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, thoughtsTokenCount: 1, totalTokenCount: 6 } };
        if (path.includes('streamGenerateContent')) { res.setHeader('content-type', 'text/event-stream'); res.end(`data: ${JSON.stringify(result)}\n\n`); }
        else res.end(JSON.stringify(result));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  it.each(['openai', 'anthropic', 'gemini'])('maps %s chat and streaming with the actual SDK', async (providerId) => {
    const source = new AIConfigService(undefined, [new StaticAIConfigSource({ defaultConfig: { ...config, providerId, baseURL: `${base}/${providerId}`, maxTokens: 32 } })]);
    const client = new NativeAIClient(source, new AICallWrapper());
    expect(await client.chat('chat', request)).toMatchObject({ content: 'hello', usage: { total: providerId === 'openai' ? 5 : 6 } });
    expect(await client.stream('chat', request)).toMatchObject({ content: 'hello', usage: { total: providerId === 'openai' ? 5 : 6 } });
    const wire = calls.filter((call) => call.path.startsWith(`/${providerId}`));
    expect(wire).toHaveLength(2);
    if (providerId === 'anthropic') expect(wire[0].body).toMatchObject({ model: config.modelId, max_tokens: 32 });
    if (providerId === 'gemini') expect(wire[0].body).toMatchObject({ contents: [{ role: 'user', parts: [{ text: 'synthetic' }] }] });
  });
  it('maps Anthropic JSON output without mixing explanatory text or reasoning into the answer', async () => {
    const source = new AIConfigService(undefined, [new StaticAIConfigSource({ defaultConfig: { ...config, providerId: 'anthropic', baseURL: `${base}/anthropic`, maxTokens: 32 } })]);
    const client = new NativeAIClient(source, new AICallWrapper());
    expect((await client.chat('json', { ...request, json: true })).content).toBe('{"ok":true}');
    expect((await client.stream('json', { ...request, json: true })).content).toBe('{"ok":true}');
    expect(calls.at(-1)?.body.tool_choice).toEqual({ type: 'tool', name: 'json_output' });
  });
  it.each(['openai', 'anthropic', 'gemini'])('does not multiply SDK retries for %s HTTP errors', async (providerId) => {
    const before = calls.length;
    const source = new AIConfigService(undefined, [new StaticAIConfigSource({ defaultConfig: { ...config, modelId: 'retry-model', providerId, baseURL: `${base}/${providerId}`, maxTokens: 32 } })]);
    const client = new NativeAIClient(source, new AICallWrapper());
    await expect(client.chat('retry', request, { maxAttempts: 2, baseDelayMs: 0 })).rejects.toThrow();
    expect(calls.length - before).toBe(2);
  });
  it('uses the configured embedding model and dimensions over actual OpenAI HTTP', async () => {
    const source = new AIConfigService(undefined, [new StaticAIConfigSource({ scenarios: { embed: { ...config, baseURL: `${base}/openai` } } })]);
    const client = new NativeAIClient(source, new AICallWrapper());
    expect(await client.embed('embed', ['text'], 2)).toMatchObject({ embeddings: [[1, 2]], usage: { input: 2, output: 0, total: 2 } });
    expect(calls.at(-1)?.body).toMatchObject({ model: 'configured-model', dimensions: 2 });
  });
});
