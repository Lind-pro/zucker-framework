import type { TokenUsage } from './ai-provider.interface';

/**
 * OpenAI / DeepSeek Chat Completions 流式 chunk 提取器。
 *
 * 把 OpenAI 的 chunk 形状映射成 callWithStream 期望的 `{ content?, usage? }`。
 *
 * **重要**：必须在 `chat.completions.create` 调用时设置
 * `stream_options: { include_usage: true }`，最后一个 chunk 才会带 usage。
 *
 * @example
 * ```ts
 * import { openAIStreamExtractor, AICallWrapper } from '@zucker/ai';
 * import OpenAI from 'openai';
 *
 * const stream = await openai.chat.completions.create({
 *   model: 'gpt-4o-mini',
 *   messages: [...],
 *   stream: true,
 *   stream_options: { include_usage: true },
 * });
 *
 * const result = await wrapper.callWithStream(
 *   () => Promise.resolve(stream),
 *   openAIStreamExtractor,
 *   { context: 'long-content' },
 * );
 * ```
 */
export function openAIStreamExtractor(chunk: any): {
  content?: string;
  usage?: TokenUsage;
} {
  const result: { content?: string; usage?: TokenUsage } = {};

  const delta = chunk?.choices?.[0]?.delta;
  if (typeof delta?.content === 'string') {
    result.content = delta.content;
  } else if (Array.isArray(delta?.content)) {
    // 极少数情况下 content 是 part 数组
    result.content = delta.content
      .map((p: any) => {
        if (typeof p === 'string') return p;
        if (typeof p?.text === 'string') return p.text;
        if (typeof p?.text?.content === 'string') return p.text.content;
        return '';
      })
      .join('');
  }

  if (chunk?.usage) {
    result.usage = {
      input: chunk.usage.prompt_tokens ?? 0,
      output: chunk.usage.completion_tokens ?? 0,
      total: chunk.usage.total_tokens ?? 0,
    };
  }

  return result;
}
