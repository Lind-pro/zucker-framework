import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  AICallObserverRegistry,
  type AICallSuccessEvent,
  type AICallErrorEvent,
} from './call-observer';
import type { TokenUsage } from './ai-provider.interface';
import { AICallTimeoutError, classifyAIError } from './ai-call-errors';
import { abortError, abortableDelay, createAbortScope, waitForAbortable } from './abort-signal';
import { sanitizeAIObserverError, sanitizeAIObserverMetadata } from './observer-sanitizer';

export type ObserverResultMode<T> = 'omit' | 'full' | ((result: T) => unknown);
export type ObserverMetadataMode = 'sanitize' | 'omit' | 'full';

export interface AICallAttemptContext {
  attempt: number;
  signal: AbortSignal;
  deadlineAt?: number;
}

export interface CallOptions<T = unknown> {
  /** Per-attempt timeout. Undefined means no framework deadline. */
  timeoutMs?: number;
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts?: number;
  /** Descriptive context for log messages */
  context?: string;
  /** Custom function to determine if an error is retryable (default: all errors are retryable) */
  isRetryable?: (error: Error) => boolean;
  /** Base delay in ms for exponential backoff (default: 1000) */
  baseDelayMs?: number;
  /** Maximum delay in ms for exponential backoff (default: 10000) */
  maxDelayMs?: number;
  /** Caller-supplied metadata, propagated to AICallObserver events */
  metadata?: Record<string, unknown>;
  /** Cancels the current attempt and any retry delay. */
  signal?: AbortSignal;
  /** Timeout retries are disabled by default to avoid duplicate provider work. */
  retryTimeouts?: boolean;
  /** Full AI output is omitted from observers unless explicitly enabled. */
  observerResult?: ObserverResultMode<T>;
  /** Metadata is sanitized by default; raw values require explicit opt-in. */
  observerMetadata?: ObserverMetadataMode;
}

/** 流式聚合调用选项 */
export interface StreamCallOptions {
  /** 上下文标识，用于日志和 observer 事件 */
  context?: string;
  /** 进度日志间隔（毫秒），默认 60000；0 = 不打印进度 */
  progressIntervalMs?: number;
  /** 调用方自定义元数据，传给 observer */
  metadata?: Record<string, unknown>;
  /** Optional total stream timeout. Undefined means no framework deadline. */
  timeoutMs?: number;
  /** Caller cancellation signal. */
  signal?: AbortSignal;
  /** Full aggregated content is omitted from observers by default. */
  observerResult?: ObserverResultMode<StreamResult>;
  /** Metadata is sanitized by default; raw values require explicit opt-in. */
  observerMetadata?: ObserverMetadataMode;
}

/** 流式聚合结果 */
export interface StreamResult {
  /** 聚合后的文本内容 */
  content: string;
  /** Token 用量（如果流末尾提供）*/
  usage?: TokenUsage;
  /** 接收的 chunk 数 */
  chunkCount: number;
  /** 总耗时（毫秒）*/
  durationMs: number;
}

@Injectable()
export class AICallWrapper {
  private readonly logger = new Logger(AICallWrapper.name);

  constructor(@Optional() private readonly observerRegistry?: AICallObserverRegistry) {}

  async callWithRetry<T>(
    fn: (context: AICallAttemptContext) => Promise<T>,
    options: CallOptions<T> = {},
  ): Promise<T> {
    const {
      timeoutMs,
      maxAttempts = 3,
      context = 'AI 调用',
      baseDelayMs = 1000,
      maxDelayMs = 10_000,
      metadata,
      signal,
      retryTimeouts = false,
      observerResult = 'omit',
      observerMetadata = 'sanitize',
    } = options;
    if (maxAttempts < 1) throw new RangeError('maxAttempts must be at least 1');
    const isRetryable =
      options.isRetryable ??
      ((error: Error) => {
        if (error instanceof AICallTimeoutError) return retryTimeouts;
        return classifyAIError(error).retryable;
      });

    let lastError: Error = new Error(`${context}: 未知错误`);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const startTime = Date.now();
      const abortScope = createAbortScope(signal, timeoutMs);
      try {
        const result = await waitForAbortable(
          Promise.resolve().then(() =>
            fn({
              attempt,
              signal: abortScope.signal,
              deadlineAt: timeoutMs === undefined ? undefined : startTime + timeoutMs,
            }),
          ),
          abortScope.signal,
        );
        const durationMs = Date.now() - startTime;

        this.logger.log(`[${context}] 成功 (attempt=${attempt}, ${durationMs}ms)`);
        await this.notifySuccess({
          context,
          startTime,
          durationMs,
          attempt,
          result: this.selectObserverResult(result, observerResult),
          metadata: this.selectObserverMetadata(metadata, observerMetadata),
        });
        return result;
      } catch (error) {
        lastError = abortScope.signal.aborted
          ? abortError(abortScope.signal)
          : error instanceof Error
            ? error
            : new Error(String(error));
        const durationMs = Date.now() - startTime;
        const safeError = sanitizeAIObserverError(lastError);
        this.logger.warn(
          `[${context}] 失败 (attempt=${attempt}/${maxAttempts}): ${safeError.message}`,
        );
        await this.notifyError({
          context,
          startTime,
          durationMs,
          attempt,
          error: safeError,
          metadata: this.selectObserverMetadata(metadata, observerMetadata),
        });

        // Do not retry non-retryable errors
        if (!isRetryable(lastError)) {
          this.logger.warn(`[${context}] 错误不可重试，直接抛出`);
          throw lastError;
        }

        if (attempt < maxAttempts) {
          const delay = this.calculateDelay(attempt, baseDelayMs, maxDelayMs);
          await abortableDelay(delay, signal);
        }
      } finally {
        abortScope.dispose();
      }
    }

    throw lastError;
  }

  /** 通知所有 observer 成功事件（单 observer 失败不影响其他）*/
  private async notifySuccess(event: AICallSuccessEvent): Promise<void> {
    if (!this.observerRegistry) return;
    for (const obs of this.observerRegistry.getAll()) {
      if (!obs.onSuccess) continue;
      try {
        await obs.onSuccess(event);
      } catch (e) {
        this.logger.warn(
          `AI Observer onSuccess 失败: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  /** 通知所有 observer 失败事件 */
  private async notifyError(event: AICallErrorEvent): Promise<void> {
    if (!this.observerRegistry) return;
    for (const obs of this.observerRegistry.getAll()) {
      if (!obs.onError) continue;
      try {
        await obs.onError(event);
      } catch (e) {
        this.logger.warn(`AI Observer onError 失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /**
   * 流式调用聚合。
   *
   * 消费 AsyncIterable<TChunk> 流，按 extractor 提取 content/usage，
   * 聚合返回。不同 provider chunk 形状不同，extractor 由调用方提供：
   * - OpenAI / DeepSeek: 用 ship 的 openAIStreamExtractor 助手
   * - Anthropic / Gemini: 各自实现（chunk 形状不同）
   *
   * @example
   * ```ts
   * import { openAIStreamExtractor } from '@zucker-framework/ai';
   * const result = await wrapper.callWithStream(
   *   () => openai.chat.completions.create({ stream: true, ... }),
   *   openAIStreamExtractor,
   *   { context: 'agent.vision', progressIntervalMs: 30000 },
   * );
   * console.log(result.content, result.usage);
   * ```
   */
  async callWithStream<TChunk>(
    streamFactory: (context: AICallAttemptContext) => Promise<AsyncIterable<TChunk>>,
    extractor: (chunk: TChunk) => { content?: string; usage?: TokenUsage },
    options: StreamCallOptions = {},
  ): Promise<StreamResult> {
    const {
      context = 'AI 流式调用',
      progressIntervalMs = 60_000,
      metadata,
      timeoutMs,
      signal,
      observerResult = 'omit',
      observerMetadata = 'sanitize',
    } = options;

    const startTime = Date.now();
    const abortScope = createAbortScope(signal, timeoutMs);
    let lastLogTime = startTime;
    let content = '';
    let chunkCount = 0;
    let usage: TokenUsage | undefined;
    let iterator: AsyncIterator<TChunk> | undefined;

    try {
      const stream = await waitForAbortable(
        Promise.resolve().then(() =>
          streamFactory({
            attempt: 1,
            signal: abortScope.signal,
            deadlineAt: timeoutMs === undefined ? undefined : startTime + timeoutMs,
          }),
        ),
        abortScope.signal,
      );
      iterator = stream[Symbol.asyncIterator]();
      while (true) {
        const next = await waitForAbortable(iterator.next(), abortScope.signal);
        if (next.done) break;
        const chunk = next.value;
        const extracted = extractor(chunk);
        if (extracted.content) content += extracted.content;
        if (extracted.usage) usage = extracted.usage;
        chunkCount += 1;

        if (progressIntervalMs > 0 && Date.now() - lastLogTime >= progressIntervalMs) {
          const elapsed = Math.floor((Date.now() - startTime) / 1000);
          const lines = content.split('\n').filter(Boolean).length;
          this.logger.log(
            `⏳ [${context}] 已耗时 ${elapsed}s，已生成 ${content.length} 字符 / ${lines} 行 / ${chunkCount} chunks`,
          );
          lastLogTime = Date.now();
        }
      }

      const durationMs = Date.now() - startTime;
      this.logger.log(
        `[${context}] 流式完成，${durationMs}ms，${content.length} 字符 / ${chunkCount} chunks`,
      );

      const result: StreamResult = { content, usage, chunkCount, durationMs };
      await this.notifySuccess({
        context,
        startTime,
        durationMs,
        attempt: 1,
        result: this.selectObserverResult(result, observerResult),
        metadata: this.selectObserverMetadata(metadata, observerMetadata),
      });

      return result;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const err = abortScope.signal.aborted
        ? abortError(abortScope.signal)
        : error instanceof Error
          ? error
          : new Error(String(error));
      const safeError = sanitizeAIObserverError(err);
      this.logger.warn(`[${context}] 流式失败 (${durationMs}ms): ${safeError.message}`);
      await this.notifyError({
        context,
        startTime,
        durationMs,
        attempt: 1,
        error: safeError,
        metadata: this.selectObserverMetadata(metadata, observerMetadata),
      });
      throw err;
    } finally {
      if (abortScope.signal.aborted && iterator?.return) {
        try {
          await iterator.return();
        } catch {
          // Provider cancellation is best effort; preserve the original abort error.
        }
      }
      abortScope.dispose();
    }
  }

  /** Calculate delay with exponential backoff and jitter to avoid thundering herd */
  private calculateDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
    const exponentialDelay = baseDelayMs * Math.pow(2, attempt - 1);
    const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
    // Add jitter: random value between 50% and 100% of the calculated delay
    const jitter = 0.5 + Math.random() * 0.5;
    return Math.floor(cappedDelay * jitter);
  }

  private selectObserverResult<T>(result: T, mode: ObserverResultMode<T>): unknown {
    if (mode === 'omit') return undefined;
    if (mode === 'full') return result;
    return mode(result);
  }

  private selectObserverMetadata(
    metadata: Record<string, unknown> | undefined,
    mode: ObserverMetadataMode,
  ): Record<string, unknown> | undefined {
    if (mode === 'omit') return undefined;
    if (mode === 'full') return metadata;
    return sanitizeAIObserverMetadata(metadata);
  }
}
