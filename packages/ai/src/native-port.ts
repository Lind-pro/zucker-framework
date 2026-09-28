import type { AIModelConfig, TokenUsage } from './ai-provider.interface';
import { AIConfigService } from './config.service';
import { AICallWrapper, type CallOptions, type StreamCallOptions } from './call-wrapper';
import { NativeAIContractError } from './native-errors';
import { createNativeAIModel } from './native-providers';

/** Text protocol. Tool/vision conversations require a separately registered capable port. */
export interface NativeMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface NativeChatRequest {
  messages: NativeMessage[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  json?: boolean;
  reasoning?: { effort?: 'low' | 'medium' | 'high'; budgetTokens?: number };
}
export interface NativeChatResult { content: string; usage?: TokenUsage; model?: string; finishReason?: string }
export interface NativeChunk { content?: string; usage?: TokenUsage }
export interface NativeEmbeddingResult { embeddings: number[][]; usage?: TokenUsage; model?: string }
export interface NativeAIModel {
  chat(request: NativeChatRequest, signal: AbortSignal): Promise<NativeChatResult>;
  stream(request: NativeChatRequest, signal: AbortSignal): Promise<AsyncIterable<NativeChunk>>;
  embed?(input: string[], dimensions: number | undefined, signal: AbortSignal): Promise<NativeEmbeddingResult>;
}
export type NativeModelFactory = (config: AIModelConfig) => Promise<NativeAIModel>;
export interface NativeRouteOptions {
  allowDefault?: boolean;
  /** Explicit caller override; clears the stored record identity when the model changes. */
  modelId?: string;
}
export interface NativeCallOptions extends CallOptions<NativeChatResult>, NativeRouteOptions {}

/** Single retry/abort/observer owner. Adapters disable SDK retries; streams never replay. */
export class NativeAIClient {
  constructor(
    private readonly configs: AIConfigService,
    private readonly calls: AICallWrapper,
    private readonly factory: NativeModelFactory = createNativeAIModel,
  ) {}

  async chat(scenario: string, request: NativeChatRequest, options: NativeCallOptions = {}) {
    const config = await this.resolve(scenario, options);
    const port = await this.factory(config);
    const result = await this.calls.callWithRetry(
      ({ signal }) => port.chat(this.request(config, request), signal),
      { ...options, context: scenario, timeoutMs: options.timeoutMs ?? config.timeoutMs },
    );
    return { ...result, config: this.identity(config) };
  }

  async stream(scenario: string, request: NativeChatRequest, options: StreamCallOptions & NativeRouteOptions = {}) {
    const config = await this.resolve(scenario, options);
    const port = await this.factory(config);
    const result = await this.calls.callWithStream(
      ({ signal }) => port.stream(this.request(config, request), signal),
      (chunk) => chunk,
      { ...options, context: scenario, timeoutMs: options.timeoutMs ?? config.timeoutMs },
    );
    return { ...result, config: this.identity(config) };
  }

  async embed(scenario: string, input: string[], dimensions?: number, options: CallOptions<NativeEmbeddingResult> = {}) {
    if (!input.length || input.some((text) => typeof text !== 'string' || !text.trim())) throw new TypeError('Embedding input must be non-empty text');
    if (dimensions !== undefined && (!Number.isSafeInteger(dimensions) || dimensions < 1)) throw new RangeError('Invalid embedding dimensions');
    // Strict routing precedes port construction: a default chat model is never an embedding fallback.
    const config = await this.configs.getScenarioConfig(scenario, { allowDefault: false });
    const port = await this.factory(config);
    const embed = port.embed?.bind(port);
    if (!embed) throw new NativeAIContractError(`Provider ${config.providerId ?? 'unknown'} does not support embeddings`);
    const result = await this.calls.callWithRetry(async ({ signal }) => {
      const output = await embed(input, dimensions, signal);
      if (output.embeddings.length !== input.length || output.embeddings.some((vector) =>
        !vector.length || (dimensions !== undefined && vector.length !== dimensions) || vector.some((n) => !Number.isFinite(n)))) {
        throw new NativeAIContractError('Provider returned invalid embedding dimensions or values');
      }
      return output;
    }, { ...options, context: scenario, timeoutMs: options.timeoutMs ?? config.timeoutMs });
    return { ...result, config: this.identity(config) };
  }

  private async resolve(scenario: string, options: NativeRouteOptions): Promise<AIModelConfig> {
    const config = await this.configs.getScenarioConfig(scenario, { allowDefault: options.allowDefault });
    if (options.modelId !== undefined && !options.modelId.trim()) throw new TypeError('modelId override must not be empty');
    return options.modelId && options.modelId !== config.modelId
      ? { ...config, modelId: options.modelId, modelRecordId: undefined } : config;
  }

  private identity(config: AIModelConfig) {
    return { modelId: config.modelId, providerId: config.providerId, modelRecordId: config.modelRecordId };
  }

  private request(config: AIModelConfig, request: NativeChatRequest): NativeChatRequest {
    return { temperature: config.temperature, maxTokens: config.maxTokens, topP: config.topP, ...request };
  }
}
