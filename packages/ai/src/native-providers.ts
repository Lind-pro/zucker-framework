import type OpenAI from 'openai';
import { NativeAIContractError } from './native-errors';
import type Anthropic from '@anthropic-ai/sdk';
import type { GoogleGenAI, GenerateContentParameters, GenerateContentResponse } from '@google/genai';
import type { AIModelConfig, TokenUsage } from './ai-provider.interface';
import type { NativeAIModel, NativeChatRequest, NativeChunk } from './native-port';
import { isOfficialOpenAIChatEndpoint, normalizeOpenAIChatParameters } from './openai-chat-parameters';

const usage = (input: number, output: number, total = input + output): TokenUsage => ({ input, output, total });

/** Adapters accept actual SDK clients, never cast another provider to the OpenAI protocol. */
export function openAINativeModel(client: OpenAI, config: AIModelConfig): NativeAIModel {
  const baseURL = client.baseURL ?? config.baseURL ?? (config.providerId === 'deepseek'
    ? 'https://api.deepseek.com/v1' : 'https://api.openai.com/v1');
  const officialOpenAI = isOfficialOpenAIChatEndpoint(new URL(`${baseURL.replace(/\/+$/, '')}/chat/completions`));
  const params = (request: NativeChatRequest): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming => {
    if (request.reasoning?.budgetTokens !== undefined) throw new NativeAIContractError('OpenAI requires reasoning effort, not a token budget');
    const body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model: config.modelId, messages: request.messages,
      temperature: request.reasoning ? undefined : request.temperature,
      ...(request.reasoning && config.providerId !== 'deepseek' ? { max_completion_tokens: request.maxTokens } : { max_tokens: request.maxTokens }),
      top_p: request.topP,
      ...(request.json ? { response_format: { type: 'json_object' } } : {}),
      ...(request.reasoning?.effort ? { reasoning_effort: request.reasoning.effort } : {}),
    };
    if (officialOpenAI) normalizeOpenAIChatParameters(body);
    return body;
  };
  return {
    async chat(request, signal) {
      const result = await client.chat.completions.create(params(request), { signal, maxRetries: 0 });
      return {
        content: result.choices[0]?.message.content ?? '', model: result.model,
        finishReason: result.choices[0]?.finish_reason,
        usage: result.usage ? usage(result.usage.prompt_tokens, result.usage.completion_tokens, result.usage.total_tokens) : undefined,
      };
    },
    async stream(request, signal) {
      const stream = await client.chat.completions.create({ ...params(request), stream: true, stream_options: { include_usage: true } }, { signal, maxRetries: 0 });
      return (async function* () {
        for await (const chunk of stream) yield {
          content: chunk.choices[0]?.delta.content ?? '',
          usage: chunk.usage ? usage(chunk.usage.prompt_tokens, chunk.usage.completion_tokens, chunk.usage.total_tokens) : undefined,
        };
      })();
    },
    async embed(input, dimensions, signal) {
      const result = await client.embeddings.create({ model: config.modelId, input, dimensions, encoding_format: 'float' }, { signal, maxRetries: 0 });
      const rows = [...result.data].sort((a, b) => a.index - b.index);
      if (rows.length !== input.length || rows.some((row, index) => row.index !== index)) throw new NativeAIContractError('Provider returned invalid embedding indexes');
      return { embeddings: rows.map((row) => row.embedding), model: result.model,
        usage: result.usage ? usage(result.usage.prompt_tokens, 0, result.usage.total_tokens) : undefined };
    },
  };
}

export function anthropicNativeModel(client: Anthropic, config: AIModelConfig): NativeAIModel {
  const params = (request: NativeChatRequest): Anthropic.MessageCreateParamsNonStreaming => {
    if (!request.maxTokens) throw new NativeAIContractError('Anthropic requires configured maxTokens');
    if (request.json && request.reasoning) throw new NativeAIContractError('Anthropic forced JSON tool cannot be combined with thinking');
    if (request.reasoning?.effort) throw new NativeAIContractError('Anthropic text port requires an explicit thinking token budget');
    return {
      model: config.modelId, max_tokens: request.maxTokens,
      system: request.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n') || undefined,
      messages: request.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
      temperature: request.reasoning ? undefined : request.temperature, top_p: request.topP,
      ...(request.json ? {
        tools: [{ name: 'json_output', description: 'Return the requested JSON object', input_schema: { type: 'object' as const, additionalProperties: true } }],
        tool_choice: { type: 'tool' as const, name: 'json_output' },
      } : {}),
      ...(request.reasoning?.budgetTokens !== undefined ? { thinking: { type: 'enabled', budget_tokens: request.reasoning.budgetTokens } as const } : {}),
    };
  };
  const inputTokens = (u: Anthropic.Usage) => u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  return {
    async chat(request, signal) {
      const result = await client.messages.create(params(request), { signal, maxRetries: 0 });
      return { content: result.content.map((b) => request.json
          ? b.type === 'tool_use' && b.name === 'json_output' ? JSON.stringify(b.input) : ''
          : b.type === 'text' ? b.text : '').join(''), model: result.model,
        finishReason: result.stop_reason ?? undefined, usage: usage(inputTokens(result.usage), result.usage.output_tokens) };
    },
    async stream(request, signal) {
      const stream = await client.messages.create({ ...params(request), stream: true }, { signal, maxRetries: 0 });
      return (async function* (): AsyncGenerator<NativeChunk> {
        let input = 0;
        for await (const event of stream) {
          if (event.type === 'message_start') {
            input = inputTokens(event.message.usage);
            yield { usage: usage(input, event.message.usage.output_tokens) };
          } else if (!request.json && event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            yield { content: event.delta.text };
          } else if (request.json && event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
            yield { content: event.delta.partial_json };
          } else if (event.type === 'message_delta') {
            yield { usage: usage(input, event.usage.output_tokens) };
          }
        }
      })();
    },
  };
}

export function geminiNativeModel(client: GoogleGenAI, config: AIModelConfig): NativeAIModel {
  const params = (request: NativeChatRequest, signal: AbortSignal): GenerateContentParameters => {
    if (request.reasoning?.effort) throw new NativeAIContractError('Gemini text port requires an explicit thinking token budget');
    return {
      model: config.modelId,
      contents: request.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      config: {
        abortSignal: signal, httpOptions: { retryOptions: { attempts: 1 } },
        systemInstruction: request.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n') || undefined,
        temperature: request.temperature, topP: request.topP, maxOutputTokens: request.maxTokens,
        ...(request.json ? { responseMimeType: 'application/json' } : {}),
        ...(request.reasoning?.budgetTokens !== undefined ? { thinkingConfig: { thinkingBudget: request.reasoning.budgetTokens } } : {}),
      },
    };
  };
  const extract = (result: GenerateContentResponse) => ({
    content: result.text ?? '', model: result.modelVersion,
    finishReason: result.candidates?.[0]?.finishReason,
    usage: result.usageMetadata ? usage(result.usageMetadata.promptTokenCount ?? 0,
      (result.usageMetadata.candidatesTokenCount ?? 0) + (result.usageMetadata.thoughtsTokenCount ?? 0),
      result.usageMetadata.totalTokenCount) : undefined,
  });
  return {
    async chat(request, signal) { return extract(await client.models.generateContent(params(request, signal))); },
    async stream(request, signal) {
      const stream = await client.models.generateContentStream(params(request, signal));
      return (async function* () { for await (const chunk of stream) yield extract(chunk); })();
    },
    async embed(input, dimensions, signal) {
      const result = await client.models.embedContent({ model: config.modelId, contents: input,
        config: { outputDimensionality: dimensions, abortSignal: signal, httpOptions: { retryOptions: { attempts: 1 } } } });
      // Gemini embedding responses do not guarantee token usage. Never fabricate billable tokens.
      return { embeddings: (result.embeddings ?? []).map((row) => row.values ?? []), model: config.modelId };
    },
  };
}

export interface NativeTransportOptions {
  /** Explicit fetch transport (e.g. dispatcher-backed proxy); never reads process.env. */
  fetch?: typeof fetch;
}
export async function createNativeAIModel(config: AIModelConfig, transport: NativeTransportOptions = {}): Promise<NativeAIModel> {
  if (!config.modelId) throw new NativeAIContractError('A configured modelId is required');
  const provider = config.providerId?.toLowerCase() ?? 'openai';
  if (config.proxyUrl && !transport.fetch) throw new NativeAIContractError('proxyUrl requires an explicit proxy-aware fetch transport or NativeModelFactory');
  if (provider === 'openai' || provider === 'deepseek') {
    const { default: SDK } = await import('openai');
    const client = new SDK({ apiKey: config.apiKey, baseURL: config.baseURL ?? (provider === 'deepseek' ? 'https://api.deepseek.com/v1' : undefined),
      timeout: config.timeoutMs, maxRetries: 0, fetch: transport.fetch });
    return openAINativeModel(client, config);
  }
  if (provider === 'anthropic' || provider === 'claude') {
    const { default: SDK } = await import('@anthropic-ai/sdk');
    return anthropicNativeModel(new SDK({ apiKey: config.apiKey, baseURL: config.baseURL, timeout: config.timeoutMs, maxRetries: 0, fetch: transport.fetch }), config);
  }
  if (provider === 'gemini') {
    if (transport.fetch || config.proxyUrl) throw new NativeAIContractError('Gemini SDK has no public fetch injection; register a proxy-aware NativeModelFactory');
    const { GoogleGenAI: SDK } = await import('@google/genai');
    return geminiNativeModel(new SDK({ apiKey: config.apiKey, httpOptions: { baseUrl: config.baseURL, timeout: config.timeoutMs, retryOptions: { attempts: 1 } } }), config);
  }
  throw new NativeAIContractError(`Unsupported native provider: ${provider}`);
}
