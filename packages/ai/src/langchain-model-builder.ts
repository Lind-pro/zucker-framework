import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { OpenAIEmbeddings } from '@langchain/openai';
import { isOfficialOpenAIChatEndpoint, normalizeOpenAIChatParameters } from './openai-chat-parameters';

export interface LangChainProviderDefaults {
  protocol: 'anthropic' | 'openai-compatible';
  baseURL?: string;
  structuredOutputMethod: 'functionCalling' | 'jsonMode';
}

/** Protocol defaults only; applications still select models, routes and endpoint overrides. */
export function getLangChainProviderDefaults(provider: string): LangChainProviderDefaults {
  switch (provider.toLowerCase()) {
    case 'claude':
    case 'anthropic':
      return { protocol: 'anthropic', structuredOutputMethod: 'functionCalling' };
    case 'openai':
      return {
        protocol: 'openai-compatible',
        baseURL: 'https://api.openai.com/v1',
        structuredOutputMethod: 'jsonMode',
      };
    case 'deepseek':
      return {
        protocol: 'openai-compatible',
        baseURL: 'https://api.deepseek.com/v1',
        structuredOutputMethod: 'jsonMode',
      };
    case 'gemini':
      return {
        protocol: 'openai-compatible',
        // Explicit compatibility endpoint, not the native Gemini API.
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
        structuredOutputMethod: 'jsonMode',
      };
    default:
      return { protocol: 'openai-compatible', structuredOutputMethod: 'jsonMode' };
  }
}

export interface LangChainChatModelOptions {
  protocol: 'anthropic' | 'openai-compatible';
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens: number;
  streaming?: boolean;
  /** Explicit caller policy; this builder adds no retry policy of its own. */
  maxRetries: number;
  baseURL?: string;
  timeoutMs?: number;
  proxyUrl?: string;
  thinking?: { enabled: boolean; reasoningEffort?: string; budgetTokens?: number };
  /** SDK v7 uses fetch, not the removed httpAgent option. */
  fetch?: typeof fetch;
}

function validateTransport(options: { proxyUrl?: string; fetch?: typeof fetch }): void {
  if (options.proxyUrl && !options.fetch) throw new Error('proxyUrl requires an explicit proxy-aware fetch transport');
}

function openAIChatFetch(transport: typeof fetch = globalThis.fetch): typeof fetch {
  return (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (!isOfficialOpenAIChatEndpoint(url) || typeof init?.body !== 'string') return transport(input, init);

    // Use the public SDK transport boundary: LangChain's model-name allowlist
    // also governs its cloned completion clients and misses newer OpenAI models.
    const body: unknown = JSON.parse(init.body);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return transport(input, init);
    const params = body as Record<string, unknown>;
    normalizeOpenAIChatParameters(params);
    return transport(input, { ...init, body: JSON.stringify(params) });
  };
}

/** SDK construction only: no model discovery, database, default route or prompts. */
export async function createLangChainChatModel(
  options: LangChainChatModelOptions,
): Promise<BaseChatModel> {
  validateTransport(options);
  if (options.protocol === 'anthropic') {
    if (options.thinking?.enabled && options.thinking.budgetTokens === undefined) throw new Error('Anthropic thinking requires budgetTokens');
    const { ChatAnthropic } = await import('@langchain/anthropic');
    return new ChatAnthropic({
      anthropicApiKey: options.apiKey,
      model: options.model,
      temperature: options.thinking?.enabled ? undefined : options.temperature,
      maxTokens: options.maxTokens,
      maxRetries: options.maxRetries,
      clientOptions: { baseURL: options.baseURL, timeout: options.timeoutMs, maxRetries: 0, fetch: options.fetch },
      ...(options.thinking ? { thinking: options.thinking.enabled
        ? { type: 'enabled' as const, budget_tokens: options.thinking.budgetTokens! }
        : { type: 'disabled' as const } } : {}),
    });
  }
  const { ChatOpenAI } = await import('@langchain/openai');
  return new ChatOpenAI({
    apiKey: options.apiKey,
    model: options.model,
    ...(options.thinking?.enabled && options.thinking.reasoningEffort !== 'none'
      ? {} : { temperature: options.temperature }),
    maxTokens: options.maxTokens,
    streaming: options.streaming,
    maxRetries: options.maxRetries,
    configuration: {
      baseURL: options.baseURL,
      timeout: options.timeoutMs,
      maxRetries: 0,
      fetch: openAIChatFetch(options.fetch),
    },
    ...(options.thinking
      ? {
          modelKwargs: {
            thinking: options.thinking.enabled
              ? { type: 'enabled' }
              : { type: 'disabled' },
            ...(options.thinking.enabled && options.thinking.reasoningEffort
              ? { reasoning_effort: options.thinking.reasoningEffort } : {}),
          },
        }
      : {}),
  });
}

export interface LangChainEmbeddingOptions {
  apiKey: string;
  /** Defaults to zero so AICallWrapper can own retries. */
  maxRetries?: number;
  fetch?: typeof fetch;
  model: string;
  dimensions?: number;
  baseURL?: string;
  timeoutMs?: number;
  proxyUrl?: string;
}

export async function createLangChainEmbeddingModel(
  options: LangChainEmbeddingOptions,
): Promise<OpenAIEmbeddings> {
  const { OpenAIEmbeddings: Embeddings } = await import('@langchain/openai');
  validateTransport(options);
  return new Embeddings({
    maxRetries: options.maxRetries ?? 0,
    apiKey: options.apiKey,
    model: options.model,
    ...(options.dimensions ? { dimensions: options.dimensions } : {}),
    configuration: {
      baseURL: options.baseURL,
      timeout: options.timeoutMs,
      maxRetries: 0,
      fetch: options.fetch,
    },
  });
}
