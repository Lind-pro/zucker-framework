import { abortableDelay, abortError } from '../abort-signal';
import type { AIModelConfig, TokenUsage } from '../ai-provider.interface';
import type {
  NativeAIModel,
  NativeChatRequest,
  NativeChatResult,
  NativeChunk,
  NativeEmbeddingResult,
  NativeModelFactory,
} from '../native-port';
import { ProviderHttpError } from '../provider-http-error';

/** One scripted reply. Omitted fields use deterministic defaults. */
export interface FakeChatStep {
  /** Reply text. Default `Echo: <last user message>`. */
  content?: string;
  /** Explicit content chunks for `stream`. Default: `content` split after each space. */
  chunks?: string[];
  /** Reasoning text streamed (as one `reasoning` chunk) before the content. */
  reasoning?: string;
  /** Usage reported. Default: `ceil(chars / 4)` of the input messages and of the reply. */
  usage?: TokenUsage;
  /** Delay before the reply / before each streamed chunk; honours the abort signal. */
  delayMs?: number;
  /**
   * Fail instead of answering. A number throws `ProviderHttpError` with that status; a string or
   * Error is thrown as is (string → Error). Applies before the first chunk unless
   * `failAfterChunks` is set.
   */
  error?: number | string | Error;
  /** Stream: throw `error` (default status 500) after this many content chunks; no usage chunk is sent. */
  failAfterChunks?: number;
  /** Default `stop`. */
  finishReason?: string;
}

export interface FakeChatModelOptions {
  /** Reported model id. Default `fake-chat`. */
  model?: string;
  script?: FakeChatStep[];
  defaultStep?: FakeChatStep;
  /** Dimensions of the deterministic `embed` vectors. Default 8. */
  embeddingDimensions?: number;
}

/** A recorded request (with the method it came through). */
export interface FakeChatCall {
  method: 'chat' | 'stream' | 'embed';
  request?: NativeChatRequest;
  input?: string[];
}

/**
 * Deterministic, scriptable `NativeAIModel` for consumers' tests. Use `factory` as the
 * `NativeModelFactory` of a `NativeAIClient`. Streams yield content chunks, then one usage chunk
 * (like OpenAI's `include_usage`). An aborted signal stops the stream with the signal's reason.
 */
export class FakeChatModel implements NativeAIModel {
  readonly calls: FakeChatCall[] = [];
  /** Config passed to `factory` most recently. */
  lastConfig?: AIModelConfig;
  private readonly model: string;
  private readonly queue: FakeChatStep[];
  private readonly defaultStep: FakeChatStep;
  private readonly dimensions: number;

  constructor(options: FakeChatModelOptions = {}) {
    this.model = options.model ?? 'fake-chat';
    this.queue = [...(options.script ?? [])];
    this.defaultStep = options.defaultStep ?? {};
    this.dimensions = options.embeddingDimensions ?? 8;
  }

  /** `NativeModelFactory` answering this instance (records the resolved config). */
  readonly factory: NativeModelFactory = async (config) => {
    this.lastConfig = config;
    return this;
  };

  enqueue(...steps: FakeChatStep[]): this {
    this.queue.push(...steps);
    return this;
  }

  get pendingSteps(): number {
    return this.queue.length;
  }

  /** Drop unconsumed script steps and recorded calls (the default step stays) so one instance can be reused between tests. */
  reset(): this {
    this.queue.length = 0;
    this.calls.length = 0;
    return this;
  }

  async chat(request: NativeChatRequest, signal: AbortSignal): Promise<NativeChatResult> {
    this.calls.push({ method: 'chat', request });
    const step = this.next();
    await delay(step, signal);
    if (step.error !== undefined) throw toError(step.error);
    const content = replyOf(step, request);
    return { content, model: this.model, finishReason: step.finishReason ?? 'stop', usage: usageOf(step, request, content) };
  }

  async stream(request: NativeChatRequest, signal: AbortSignal): Promise<AsyncIterable<NativeChunk>> {
    this.calls.push({ method: 'stream', request });
    const step = this.next();
    if (step.error !== undefined && step.failAfterChunks === undefined) {
      await delay(step, signal);
      throw toError(step.error);
    }
    const content = replyOf(step, request);
    const chunks = step.chunks ?? splitChunks(content);
    const usage = usageOf(step, request, chunks.join(''));
    return (async function* (): AsyncGenerator<NativeChunk> {
      if (step.reasoning) {
        await delay(step, signal);
        yield { reasoning: step.reasoning };
      }
      for (let index = 0; index < chunks.length; index += 1) {
        if (step.failAfterChunks !== undefined && index >= step.failAfterChunks) throw toError(step.error ?? 500);
        await delay(step, signal);
        yield { content: chunks[index] };
      }
      if (step.failAfterChunks !== undefined && chunks.length <= step.failAfterChunks) throw toError(step.error ?? 500);
      await delay({}, signal);
      yield { usage };
    })();
  }

  async embed(input: string[], dimensions: number | undefined, signal: AbortSignal): Promise<NativeEmbeddingResult> {
    this.calls.push({ method: 'embed', input: [...input] });
    const step = this.next();
    await delay(step, signal);
    if (step.error !== undefined) throw toError(step.error);
    const size = dimensions ?? this.dimensions;
    const tokens = input.reduce((sum, text) => sum + tokenCount(text), 0);
    return {
      embeddings: input.map((text) => Array.from({ length: size }, (_, index) => vectorValue(text, index))),
      model: this.model,
      usage: { input: tokens, output: 0, total: tokens },
    };
  }

  private next(): FakeChatStep {
    return { ...this.defaultStep, ...(this.queue.shift() ?? {}) };
  }
}

/** Default token estimate used by the fake: `ceil(chars / 4)`. Exported so tests can compute expectations. */
export function fakeTokenCount(text: string): number {
  return tokenCount(text);
}

function tokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

function replyOf(step: FakeChatStep, request: NativeChatRequest): string {
  if (step.content !== undefined) return step.content;
  if (step.chunks) return step.chunks.join('');
  const last = [...request.messages].reverse().find((message) => message.role === 'user');
  return `Echo: ${last?.content ?? ''}`;
}

function usageOf(step: FakeChatStep, request: NativeChatRequest, content: string): TokenUsage {
  if (step.usage) return { ...step.usage };
  const input = request.messages.reduce((sum, message) => sum + tokenCount(message.content), 0);
  const output = tokenCount(content) + (step.reasoning ? tokenCount(step.reasoning) : 0);
  return { input, output, total: input + output };
}

function splitChunks(content: string): string[] {
  return content.match(/[^ ]+ ?| /g) ?? [];
}

function toError(error: number | string | Error): Error {
  if (typeof error === 'number') return new ProviderHttpError('Fake chat', error, 'fake provider failure');
  return typeof error === 'string' ? new Error(error) : error;
}

async function delay(step: Pick<FakeChatStep, 'delayMs'>, signal: AbortSignal): Promise<void> {
  // No timer without a delay (works under fake timers); an aborted signal still stops the call.
  if (signal.aborted) throw abortError(signal);
  if (step.delayMs && step.delayMs > 0) await abortableDelay(step.delayMs, signal);
}

function vectorValue(text: string, index: number): number {
  let hash = 2166136261 ^ index;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return ((hash >>> 0) % 2000) / 1000 - 1;
}
