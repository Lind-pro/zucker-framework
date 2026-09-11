import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { Serialized } from '@langchain/core/load/serializable';
import type { LLMResult } from '@langchain/core/outputs';

export interface LangChainCallSummary {
  duration: number;
  contentLength: number;
  usage: Record<string, unknown> | undefined;
  finishReason: unknown;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}
export interface LangChainCallObserverOptions {
  name?: string;
  onSuccess(summary: LangChainCallSummary): Promise<void>;
  onError(error: Error, duration: number): Promise<void>;
}

/** Capture only timing and usage; prompts and response text never enter the observation contract. */
export class LangChainCallObserver extends BaseCallbackHandler {
  name: string;
  private readonly starts = new Map<string, number>();
  constructor(private readonly options: LangChainCallObserverOptions) {
    super();
    this.name = options.name ?? 'langchain-call-observer';
  }
  async handleLLMStart(_llm: Serialized, _prompts: string[], runId: string): Promise<void> {
    this.starts.set(runId, Date.now());
  }
  async handleLLMEnd(output: LLMResult, runId: string): Promise<void> {
    const generation = output?.generations?.[0]?.[0];
    const usage = (output?.llmOutput?.tokenUsage ?? output?.llmOutput?.usage) as
      Record<string, unknown> | undefined;
    const token = (camel: string, snake: string): number | undefined => {
      const value = usage?.[camel] ?? usage?.[snake];
      return typeof value === 'number' ? value : undefined;
    };
    await this.options.onSuccess({
      duration: this.finish(runId),
      contentLength: generation?.text?.length ?? 0,
      usage,
      finishReason: generation?.generationInfo?.finish_reason,
      promptTokens: token('promptTokens', 'prompt_tokens'),
      completionTokens: token('completionTokens', 'completion_tokens'),
      totalTokens: token('totalTokens', 'total_tokens'),
    });
  }
  async handleLLMError(error: Error, runId: string): Promise<void> {
    await this.options.onError(error, this.finish(runId));
  }
  private finish(runId: string): number {
    const start = this.starts.get(runId) ?? Date.now();
    this.starts.delete(runId);
    return Date.now() - start;
  }
}
