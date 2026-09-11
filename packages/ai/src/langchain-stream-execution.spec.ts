import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { StreamIdleTimeoutError } from '@zucker-framework/core';
import { collectLangChainText, executeLangChainStructured } from './langchain-stream-execution';
import { StructuredOutputValidationError } from './structured-output';

const base = { systemPrompt: 'system', userPrompt: 'input', idleTimeoutMs: 1000 };
afterEach(() => vi.useRealTimers());

describe('LangChain stream execution', () => {
  it('preserves multi-role/image input, reply whitespace and last usage-bearing chunk', async () => {
    const messages = [
      new SystemMessage('system'),
      new HumanMessage('earlier question'),
      new AIMessage('earlier answer'),
      new HumanMessage({
        content: [
          { type: 'text', text: 'describe' },
          { type: 'image_url', image_url: { url: 'https://example.test/image' } },
        ],
      }),
    ];
    const usage = { input_tokens: 7, output_tokens: 3, total_tokens: 10 };
    const stream = vi.fn(async function* (_input: unknown) {
      yield {
        content: '  reply',
        additional_kwargs: {},
        usage_metadata: { input_tokens: 7, output_tokens: 1, total_tokens: 8 },
      };
      yield { content: '\n', additional_kwargs: {}, usage_metadata: usage };
      yield { content: '', additional_kwargs: {} };
    });
    const result = await collectLangChainText({
      model: { stream } as unknown as BaseChatModel,
      messages,
      trim: false,
    });
    expect(stream.mock.calls[0]?.[0]).toBe(messages);
    expect(result).toMatchObject({ text: '  reply\n', usage, chunkCount: 3 });
  });
  it('collects answer text and counts reasoning without mixing reasoning into the answer', async () => {
    const model = {
      stream: vi.fn(async function* () {
        yield { content: '', additional_kwargs: { reasoning_content: 'think' } };
        yield { content: ' answer ', additional_kwargs: {} };
      }),
    };
    const onFirstChunk = vi.fn();
    await expect(
      collectLangChainText({ ...base, model: model as unknown as BaseChatModel, onFirstChunk }),
    ).resolves.toMatchObject({ text: 'answer', chunkCount: 2, reasoningCharCount: 5 });
    expect(onFirstChunk).toHaveBeenCalledTimes(1);
  });
  it('applies structured transforms and does not enable recovery unless explicitly configured', async () => {
    const schema = z.object({ title: z.string().trim() });
    const stream = vi.fn(async function* () {
      yield { title: ' ready ' };
    });
    const model = { withStructuredOutput: vi.fn(() => ({ stream })) };
    await expect(
      executeLangChainStructured({
        ...base,
        model: model as unknown as BaseChatModel,
        schema,
        method: 'jsonMode',
      }),
    ).resolves.toEqual({ title: 'ready' });
    const error = new Error('OUTPUT_PARSING_FAILURE');
    stream.mockImplementation(async function* () {
      throw error;
    });
    await expect(
      executeLangChainStructured({
        ...base,
        model: model as unknown as BaseChatModel,
        schema,
        method: 'jsonMode',
      }),
    ).rejects.toBe(error);
  });
  it('uses at most the supplied recovery and validates its result rather than accepting syntax only', async () => {
    const original = Object.assign(new Error('OUTPUT_PARSING_FAILURE'), { llmOutput: '{"bad":' });
    const model = {
      withStructuredOutput: () => ({
        stream: async function* () {
          throw original;
        },
      }),
    };
    const repair = vi.fn(async () => '{"title":"ready"}');
    const options = {
      ...base,
      model: model as unknown as BaseChatModel,
      schema: z.object({ title: z.string() }),
      method: 'jsonMode' as const,
      repair,
    };
    await expect(executeLangChainStructured(options)).resolves.toEqual({ title: 'ready' });
    expect(repair).toHaveBeenCalledTimes(1);
    repair.mockResolvedValueOnce('{"unexpected":true}');
    await expect(executeLangChainStructured(options)).rejects.toBeInstanceOf(
      StructuredOutputValidationError,
    );
  });
  it('never treats idle timeout as a schema-repair request', async () => {
    const error = new StreamIdleTimeoutError('stalled');
    const model = {
      withStructuredOutput: () => ({
        stream: async function* () {
          throw error;
        },
      }),
    };
    const repair = vi.fn();
    await expect(
      executeLangChainStructured({
        ...base,
        model: model as unknown as BaseChatModel,
        schema: z.object({ value: z.string() }),
        method: 'jsonMode',
        repair,
      }),
    ).rejects.toBe(error);
    expect(repair).not.toHaveBeenCalled();
  });
});
