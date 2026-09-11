import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { OpenAIEmbeddings } from '@langchain/openai';

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
        baseURL: 'https://generativelanguage.googleapis.com/v1beta',
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
  thinking?: { enabled: boolean; reasoningEffort?: string };
}

async function proxyAgent(url?: string) {
  if (!url) return undefined;
  const { HttpsProxyAgent } = await import('https-proxy-agent');
  return new HttpsProxyAgent(url);
}

/** SDK construction only: no model discovery, database, default route or prompts. */
export async function createLangChainChatModel(
  options: LangChainChatModelOptions,
): Promise<BaseChatModel> {
  if (options.protocol === 'anthropic') {
    const { ChatAnthropic } = await import('@langchain/anthropic');
    return new ChatAnthropic({
      anthropicApiKey: options.apiKey,
      model: options.model,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      maxRetries: options.maxRetries,
    });
  }
  const { ChatOpenAI } = await import('@langchain/openai');
  const httpAgent = await proxyAgent(options.proxyUrl);
  return new ChatOpenAI({
    apiKey: options.apiKey,
    model: options.model,
    ...(options.thinking?.enabled ? {} : { temperature: options.temperature }),
    maxTokens: options.maxTokens,
    streaming: options.streaming,
    maxRetries: options.maxRetries,
    configuration: {
      baseURL: options.baseURL,
      timeout: options.timeoutMs,
      ...(httpAgent ? { httpAgent } : {}),
    },
    ...(options.thinking
      ? {
          modelKwargs: {
            thinking: options.thinking.enabled
              ? { type: 'enabled', reasoning_effort: options.thinking.reasoningEffort }
              : { type: 'disabled' },
          },
        }
      : {}),
  });
}

export interface LangChainEmbeddingOptions {
  apiKey: string;
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
  const httpAgent = await proxyAgent(options.proxyUrl);
  return new Embeddings({
    apiKey: options.apiKey,
    model: options.model,
    ...(options.dimensions ? { dimensions: options.dimensions } : {}),
    configuration: {
      baseURL: options.baseURL,
      timeout: options.timeoutMs,
      ...(httpAgent ? { httpAgent } : {}),
    },
  });
}
