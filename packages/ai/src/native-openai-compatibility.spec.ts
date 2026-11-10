// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { AIConfigService } from './config.service';
import { StaticAIConfigSource } from './config-sources/static-config.source';
import { AICallWrapper } from './call-wrapper';
import { NativeAIClient, type NativeChatRequest } from './native-port';
import { createNativeAIModel } from './native-providers';
import type { AIModelConfig } from './ai-provider.interface';

const defaults: AIModelConfig = {
  apiKey: 'synthetic-test-key',
  providerId: 'openai',
  modelId: 'gpt-6.1-sol',
  maxTokens: 321,
  temperature: 0.7,
  topP: 0.9,
  timeoutMs: 1000,
};
const request: NativeChatRequest = {
  messages: [{ role: 'user', content: 'Synthetic input' }],
  json: true,
};

function fixture(overrides: Partial<AIModelConfig> = {}) {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (...args) => {
    const sent = new Request(...args);
    const body = await sent.json() as Record<string, unknown>;
    requests.push({ url: sent.url, body });
    const common = { id: 'synthetic', created: 0, model: body.model };
    const usage = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 };
    if (body.stream) {
      const packets = [
        { choices: [{ index: 0, delta: { content: '{"ok":true}' }, finish_reason: null }] },
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
      choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }],
    });
  });
  const config = new AIConfigService(undefined, [new StaticAIConfigSource({
    scenarios: { synthetic: { ...defaults, ...overrides } },
  })]);
  const client = new NativeAIClient(config, new AICallWrapper(),
    model => createNativeAIModel(model, { fetch }));
  return { client, requests, fetch };
}

describe('native OpenAI requests through the installed SDK', () => {
  describe.each(['chat', 'stream'] as const)('%s', method => {
    it.each([undefined, 'https://api.openai.com/v1', 'https://api.openai.com/v1/'])(
      'uses completion tokens without requiring reasoning for endpoint %s', async baseURL => {
        const f = fixture({ baseURL });
        const result = await f.client[method]('synthetic', request);
        expect(result).toMatchObject({ content: '{"ok":true}', usage: { input: 7, output: 3, total: 10 } });
        expect(f.fetch).toHaveBeenCalledTimes(1);
        expect(f.requests[0].url).toBe('https://api.openai.com/v1/chat/completions');
        expect(f.requests[0].body).toMatchObject({
          model: defaults.modelId, max_completion_tokens: 321,
          response_format: { type: 'json_object' }, messages: request.messages,
        });
        expect(f.requests[0].body).not.toHaveProperty('max_tokens');
        expect(f.requests[0].body).not.toHaveProperty('temperature');
        expect(f.requests[0].body).not.toHaveProperty('top_p');
        if (method === 'stream') expect(f.requests[0].body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
      },
    );

    it.each(['gpt-4o', 'gpt-4o-mini'])('preserves configured sampling for %s with the supported token field', async modelId => {
      const f = fixture({ modelId });
      await f.client[method]('synthetic', request);
      expect(f.requests[0].body).toMatchObject({ model: modelId, temperature: 0.7, top_p: 0.9, max_completion_tokens: 321 });
      expect(f.requests[0].body).not.toHaveProperty('max_tokens');
    });

    it('preserves explicit reasoning and the caller output limit', async () => {
      const f = fixture();
      await f.client[method]('synthetic', { ...request, maxTokens: 123, reasoning: { effort: 'low' } });
      expect(f.requests[0].body).toMatchObject({ reasoning_effort: 'low', max_completion_tokens: 123 });
      expect(f.requests[0].body).not.toHaveProperty('max_tokens');
      expect(f.requests[0].body).not.toHaveProperty('top_p');
    });

    it.each([
      { providerId: 'deepseek', modelId: 'deepseek-v4-flash', baseURL: 'https://api.deepseek.com/v1' },
      { providerId: 'openai', modelId: 'configured-model', baseURL: 'https://private-gateway.test/v1' },
    ])('preserves the existing token contract at $baseURL', async config => {
      const f = fixture(config);
      await f.client[method]('synthetic', request);
      expect(f.requests[0].body).toMatchObject({ model: config.modelId, max_tokens: 321, temperature: 0.7, top_p: 0.9 });
      expect(f.requests[0].body).not.toHaveProperty('max_completion_tokens');
    });
  });
});
