import type { AIModelConfig, NativeModelFactory } from '@zucker-framework/ai';
import { createNativeAIModel } from '@zucker-framework/ai/native';
import { connectionSdkAvailable } from '../runtime-settings/connection-sdk';

export const AI_CONNECTIONS = [
  {
    id: 'ai-openai',
    route: 'connection.openai',
    name: 'OpenAI',
    prefix: 'AI_OPENAI',
    provider: 'openai',
    sdk: 'openai',
    baseURL: 'https://api.openai.com/v1',
  },
  {
    id: 'ai-compatible',
    route: 'connection.compatible',
    name: 'OpenAI 兼容接口',
    prefix: 'AI_COMPATIBLE',
    provider: 'openai',
    sdk: 'openai',
    baseURL: undefined,
  },
  {
    id: 'ai-openrouter',
    route: 'connection.openrouter',
    name: 'OpenRouter',
    prefix: 'AI_OPENROUTER',
    provider: 'openai',
    sdk: 'openai',
    baseURL: 'https://openrouter.ai/api/v1',
  },
  {
    id: 'ai-deepseek',
    route: 'connection.deepseek',
    name: 'DeepSeek',
    prefix: 'AI_DEEPSEEK',
    provider: 'deepseek',
    sdk: 'openai',
    baseURL: 'https://api.deepseek.com/v1',
  },
  {
    id: 'ai-anthropic',
    route: 'connection.anthropic',
    name: 'Anthropic',
    prefix: 'AI_ANTHROPIC',
    provider: 'anthropic',
    sdk: '@anthropic-ai/sdk',
    baseURL: 'https://api.anthropic.com',
  },
  {
    id: 'ai-gemini',
    route: 'connection.gemini',
    name: 'Gemini（GenAI）',
    prefix: 'AI_GEMINI',
    provider: 'gemini',
    sdk: '@google/genai',
    baseURL: 'https://generativelanguage.googleapis.com',
  },
] as const;
export type AIConnectionDefinition = (typeof AI_CONNECTIONS)[number];
export type AIConnectionEnvironment = Readonly<Record<string, string | undefined>>;
export class AIConnectionUnavailableError extends Error {
  constructor(
    readonly reason:
      | 'unknown_route'
      | 'disabled'
      | 'missing_configuration'
      | 'invalid_configuration'
      | 'missing_sdk'
      | 'assembly_failed',
  ) {
    super(`AI connection is unavailable (${reason})`);
    this.name = 'AIConnectionUnavailableError';
  }
}
export function aiConnectionEnabled(
  definition: AIConnectionDefinition,
  env: AIConnectionEnvironment,
): boolean {
  const value = env[`${definition.prefix}_ENABLED`];
  if (value !== undefined && value !== '' && value !== 'true' && value !== 'false')
    throw new AIConnectionUnavailableError('invalid_configuration');
  return value === 'true';
}
const positiveInteger = (value: string | undefined, fallback?: number): number | undefined => {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)
    throw new AIConnectionUnavailableError('invalid_configuration');
  return Number(value);
};
export function aiConnectionConfig(
  definition: AIConnectionDefinition,
  env: AIConnectionEnvironment,
  sdkAvailable: (owner: string, dependency: string) => boolean = connectionSdkAvailable,
): AIModelConfig {
  if (!aiConnectionEnabled(definition, env)) throw new AIConnectionUnavailableError('disabled');
  const read = (suffix: string) => env[`${definition.prefix}_${suffix}`];
  const apiKey = read('API_KEY'),
    modelId = read('MODEL_ID')?.trim(),
    baseURL = read('BASE_URL')?.trim() || definition.baseURL;
  const maxTokens = positiveInteger(read('MAX_TOKENS')),
    timeoutMs = positiveInteger(read('TIMEOUT_MS'), 60_000)!;
  if (
    !apiKey?.trim() ||
    !modelId ||
    !baseURL ||
    (definition.provider === 'anthropic' && !maxTokens)
  )
    throw new AIConnectionUnavailableError('missing_configuration');
  if (
    apiKey.length > 16384 ||
    modelId.length > 2048 ||
    /[\u0000-\u001f\u007f]/.test(apiKey + modelId) ||
    timeoutMs > 600_000 ||
    (maxTokens !== undefined && maxTokens > 1_048_576)
  )
    throw new AIConnectionUnavailableError('invalid_configuration');
  try {
    const url = new URL(baseURL);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      baseURL.length > 2048
    )
      throw new Error();
  } catch {
    throw new AIConnectionUnavailableError('invalid_configuration');
  }
  if (!sdkAvailable('@zucker-framework/ai', definition.sdk))
    throw new AIConnectionUnavailableError('missing_sdk');
  return {
    apiKey,
    modelId,
    baseURL,
    providerId: definition.provider,
    modelRecordId: definition.id,
    maxTokens,
    timeoutMs,
  };
}
/** SDK construction only: no prompt, HTTP request or remote credential verification. */
export async function validateAIConnection(
  id: string,
  env: AIConnectionEnvironment,
  dependencies: {
    sdkAvailable?: (owner: string, dependency: string) => boolean;
    factory?: NativeModelFactory;
  } = {},
): Promise<void> {
  const definition = AI_CONNECTIONS.find((item) => item.id === id);
  if (!definition) throw new AIConnectionUnavailableError('unknown_route');
  if (!aiConnectionEnabled(definition, env)) return;
  const config = aiConnectionConfig(definition, env, dependencies.sdkAvailable);
  try {
    await (dependencies.factory ?? createNativeAIModel)(config);
  } catch {
    throw new AIConnectionUnavailableError('assembly_failed');
  }
}
/** Safe local metadata. A configured connection has not been remotely verified. */
export function inspectAIConnections(env: AIConnectionEnvironment) {
  return AI_CONNECTIONS.map((definition) => {
    const sdkAvailable = connectionSdkAvailable('@zucker-framework/ai', definition.sdk);
    let enabled = false,
      status: 'disabled' | 'missing' | 'invalid' | 'missing-sdk' | 'configured' = 'disabled';
    const missing: string[] = [];
    try {
      enabled = aiConnectionEnabled(definition, env);
      if (enabled) {
        for (const suffix of [
          'API_KEY',
          'MODEL_ID',
          ...(definition.provider === 'anthropic' ? ['MAX_TOKENS'] : []),
          ...(!definition.baseURL ? ['BASE_URL'] : []),
        ])
          if (!env[`${definition.prefix}_${suffix}`]?.trim())
            missing.push(`${definition.prefix}_${suffix}`);
        aiConnectionConfig(definition, env);
        status = 'configured';
      }
    } catch (error) {
      status =
        error instanceof AIConnectionUnavailableError && error.reason === 'missing_sdk'
          ? 'missing-sdk'
          : missing.length
            ? 'missing'
            : 'invalid';
    }
    return {
      id: definition.id,
      name: definition.name,
      category: 'AI',
      enabled,
      missing,
      sdkAvailable,
      status,
    };
  });
}
