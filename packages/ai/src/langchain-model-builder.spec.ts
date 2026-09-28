import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLangChainChatModel,
  createLangChainEmbeddingModel,
  getLangChainProviderDefaults,
} from './langchain-model-builder';
const calls = vi.hoisted(() => ({
  openai: vi.fn(),
  anthropic: vi.fn(),
  embeddings: vi.fn(),
  proxy: vi.fn(),
}));
vi.mock('@langchain/openai', () => ({
  ChatOpenAI: class {
    constructor(options: unknown) {
      calls.openai(options);
    }
  },
  OpenAIEmbeddings: class {
    constructor(options: unknown) {
      calls.embeddings(options);
    }
  },
}));
vi.mock('@langchain/anthropic', () => ({
  ChatAnthropic: class {
    constructor(options: unknown) {
      calls.anthropic(options);
    }
  },
}));
vi.mock('https-proxy-agent', () => ({
  HttpsProxyAgent: class {
    constructor(url: string) {
      calls.proxy(url);
    }
  },
}));
beforeEach(() => {
  Object.values(calls).forEach((mock) => mock.mockClear());
});

describe('LangChain model construction', () => {
  it('rejects ignored proxy and incomplete Anthropic thinking configurations', async () => {
    await expect(createLangChainEmbeddingModel({ apiKey: 'synthetic', model: 'configured', proxyUrl: 'http://proxy.test' })).rejects.toThrow('proxy-aware');
    await expect(createLangChainChatModel({ protocol: 'anthropic', apiKey: 'synthetic', model: 'configured', maxTokens: 100, maxRetries: 0, thinking: { enabled: true } })).rejects.toThrow('budgetTokens');
  });
  it('passes Anthropic endpoint, timeout, transport and native thinking', async () => {
    await createLangChainChatModel({ protocol: 'anthropic', apiKey: 'synthetic', model: 'configured', maxTokens: 4000, maxRetries: 0, baseURL: 'https://synthetic.test', timeoutMs: 100, fetch, thinking: { enabled: true, budgetTokens: 1024 } });
    expect(calls.anthropic).toHaveBeenCalledWith(expect.objectContaining({ clientOptions: { baseURL: 'https://synthetic.test', timeout: 100, maxRetries: 0, fetch }, thinking: { type: 'enabled', budget_tokens: 1024 } }));
  });
  it('chooses compatible protocol defaults without manufacturing a custom-provider endpoint', () => {
    expect(getLangChainProviderDefaults('Claude')).toEqual({
      protocol: 'anthropic',
      structuredOutputMethod: 'functionCalling',
    });
    expect(getLangChainProviderDefaults('DeepSeek')).toEqual({
      protocol: 'openai-compatible',
      baseURL: 'https://api.deepseek.com/v1',
      structuredOutputMethod: 'jsonMode',
    });
    expect(getLangChainProviderDefaults('Gemini').baseURL).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai',
    );
    expect(getLangChainProviderDefaults('private-gateway')).toEqual({
      protocol: 'openai-compatible',
      structuredOutputMethod: 'jsonMode',
    });
  });
  it('preserves explicit retries, compatible endpoint/timeout and thinking transport', async () => {
    await createLangChainChatModel({
      protocol: 'openai-compatible',
      apiKey: 'synthetic',
      model: 'configured',
      maxTokens: 8000,
      temperature: 0.7,
      maxRetries: 3,
      timeoutMs: 900000,
      baseURL: 'https://provider.test/v1',
      thinking: { enabled: true, reasoningEffort: 'high' },
    });
    expect(calls.openai).toHaveBeenCalledWith(
      expect.objectContaining({
        maxRetries: 3,
        maxTokens: 8000,
        modelKwargs: { thinking: { type: 'enabled' }, reasoning_effort: 'high' },
        configuration: { baseURL: 'https://provider.test/v1', timeout: 900000, maxRetries: 0, fetch: undefined },
      }),
    );
    expect(calls.openai.mock.calls[0][0]).not.toHaveProperty('temperature');
  });
  it('sends disabled thinking only when the caller declares support', async () => {
    await createLangChainChatModel({
      protocol: 'openai-compatible',
      apiKey: 'synthetic',
      model: 'configured',
      maxTokens: 1000,
      temperature: 0.3,
      maxRetries: 0,
      thinking: { enabled: false },
    });
    expect(calls.openai).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0.3,
        modelKwargs: { thinking: { type: 'disabled' } },
        maxRetries: 0,
      }),
    );
  });
  it('creates Anthropic and embedding clients without adding retry/default-route policies', async () => {
    await createLangChainChatModel({
      protocol: 'anthropic',
      apiKey: 'synthetic',
      model: 'configured',
      maxTokens: 1000,
      maxRetries: 0,
    });
    expect(calls.anthropic).toHaveBeenCalledWith(
      expect.objectContaining({ anthropicApiKey: 'synthetic', model: 'configured', maxRetries: 0 }),
    );
    await createLangChainEmbeddingModel({
      apiKey: 'synthetic',
      model: 'embedding',
      dimensions: 512,
      proxyUrl: 'http://proxy.test',
      fetch,
    });
    expect(calls.proxy).not.toHaveBeenCalled();
    expect(calls.embeddings).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'embedding', dimensions: 512 }),
    );
    expect(calls.embeddings.mock.calls[0][0]).toMatchObject({ maxRetries: 0, configuration: { maxRetries: 0, fetch } });
  });
});
