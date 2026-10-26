// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ChatOpenAICallOptions } from '@langchain/openai';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { StreamIdleTimeoutError } from '@zucker-framework/core';
import { collectLangChainText, executeLangChainStructured } from './langchain-stream-execution';
import { StructuredOutputValidationError } from './structured-output';
import { createLangChainChatModel } from './langchain-model-builder';
import { LangChainCallObserver } from './langchain-call-observer';
import { awaitAllCallbacks } from '@langchain/core/callbacks/promises';

const base = { systemPrompt: 'system', userPrompt: 'input', idleTimeoutMs: 1000 };
afterEach(() => vi.useRealTimers());

function syntheticOpenAIStream() {
  const packets = [
    {
      choices: [{ index: 0, delta: { role: 'assistant', content: 'first' }, finish_reason: null }],
    },
    { choices: [{ index: 0, delta: { content: ' second' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } },
  ];
  const body =
    packets
      .map(
        (packet) =>
          'data: ' +
          JSON.stringify({
            id: 'synthetic',
            object: 'chat.completion.chunk',
            model: 'synthetic',
            ...packet,
          }) +
          '\n\n',
      )
      .join('') + 'data: [DONE]\n\n';
  return vi.fn(
    async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
  );
}

describe('LangChain stream execution', () => {
  it('accepts a publicly configured Runnable and collects stream usage in one attempt', async () => {
    const respond = syntheticOpenAIStream();
    const fetch = vi.fn(async (...args: Parameters<typeof globalThis.fetch>) => {
      const request = new Request(...args);
      expect(await request.json()).toMatchObject({
        response_format: { type: 'json_object' },
        stream: true,
      });
      return respond();
    });
    const model = await createLangChainChatModel({
      protocol: 'openai-compatible',
      apiKey: 'synthetic',
      model: 'synthetic',
      maxTokens: 100,
      maxRetries: 0,
      timeoutMs: 1000,
      fetch,
    });
    const callOptions: Partial<ChatOpenAICallOptions> = {
      response_format: { type: 'json_object' },
    };
    const configured = model.withConfig(callOptions);
    const messages = [new HumanMessage('return JSON')];
    const result = await collectLangChainText({ model: configured, messages });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      text: 'first second',
      finishReason: 'stop',
      usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
    });
  });

  it('gets finish metadata from the actual SDK stream before queued logging observers complete', async () => {
    const fetch = syntheticOpenAIStream();
    const model = await createLangChainChatModel({
      protocol: 'openai-compatible',
      apiKey: 'synthetic',
      model: 'synthetic',
      maxTokens: 100,
      maxRetries: 0,
      timeoutMs: 1000,
      fetch,
    });
    let release!: () => void;
    const pendingLog = new Promise<void>((resolve) => {
      release = resolve;
    });
    const logging = new LangChainCallObserver({
      onSuccess: async () => pendingLog,
      onError: async () => {},
    });
    const finished = vi.fn();
    const later = new LangChainCallObserver({ onSuccess: finished, onError: async () => {} });
    logging.awaitHandlers = false;
    later.awaitHandlers = false;
    try {
      const result = await collectLangChainText({ ...base, model, callbacks: [logging, later] });
      expect(finished).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        text: 'first second',
        finishReason: 'stop',
        usage: { total_tokens: 10 },
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await awaitAllCallbacks();
    }
    expect(finished).toHaveBeenCalledWith(expect.objectContaining({ finishReason: 'stop' }));
  });

  it('preserves the original paragraph consumer error through actual SDK abort cleanup', async () => {
    const fetch = syntheticOpenAIStream();
    const model = await createLangChainChatModel({
      protocol: 'openai-compatible',
      apiKey: 'synthetic',
      model: 'synthetic',
      maxTokens: 100,
      maxRetries: 0,
      timeoutMs: 1000,
      fetch,
    });
    const failure = Object.assign(new Error('paragraph schema failed'), {
      code: 'WRITING_PLAN_INVALID_BLOCK',
    });
    await expect(
      collectLangChainText({
        ...base,
        model,
        onTextDelta: () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(fetch).toHaveBeenCalledTimes(1);
    await awaitAllCallbacks();
  });

  it.each(['stop', 'length', 'tool_calls'])(
    'preserves explicit terminal metadata %s across a later usage-only chunk',
    async (finishReason) => {
      const model = {
        stream: async function* () {
          yield { content: 'answer', response_metadata: { finish_reason: finishReason } };
          yield {
            content: '',
            usage_metadata: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
          };
        },
      };
      expect(
        await collectLangChainText({ ...base, model: model as unknown as BaseChatModel }),
      ).toMatchObject({ finishReason });
    },
  );

  it('awaits answer deltas before reading another chunk and excludes reasoning content', async () => {
    const order: string[] = [];
    const model = {
      stream: async function* () {
        yield { content: '', additional_kwargs: { reasoning_content: 'hidden' } };
        yield {
          content: [
            { type: 'thinking', thinking: 'hidden' },
            { type: 'text', text: 'first' },
          ],
        };
        order.push('next');
        yield { content: ' second' };
      },
    };
    const result = await collectLangChainText({
      ...base,
      model: model as unknown as BaseChatModel,
      onTextDelta: async (delta) => {
        await Promise.resolve();
        order.push(delta);
      },
    });
    expect(order).toEqual(['first', 'next', ' second']);
    expect(result).toMatchObject({ text: 'first second', reasoningCharCount: 6 });
  });

  it('propagates a consumer failure and aborts the provider without consuming later output', async () => {
    let providerSignal: AbortSignal | undefined;
    const afterFailure = vi.fn();
    const error = new Error('durable write failed');
    const model = {
      stream: async function* (_input: unknown, options: { signal: AbortSignal }) {
        providerSignal = options.signal;
        yield { content: 'first' };
        afterFailure();
        yield { content: 'second' };
      },
    };
    await expect(
      collectLangChainText({
        ...base,
        model: model as unknown as BaseChatModel,
        onTextDelta: async () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);
    expect(providerSignal?.aborted).toBe(true);
    expect(afterFailure).not.toHaveBeenCalled();
  });

  it('rejects cancellation from the final delta even when the provider closes normally', async () => {
    const controller = new AbortController();
    const onComplete = vi.fn();
    const model = {
      stream: async function* () {
        yield { content: 'final answer', response_metadata: { finish_reason: 'stop' } };
      },
    };
    await expect(
      collectLangChainText({
        ...base,
        model: model as unknown as BaseChatModel,
        signal: controller.signal,
        onTextDelta: () => controller.abort(),
        onComplete,
      }),
    ).rejects.toMatchObject({ name: 'AICallAbortedError' });
    expect(onComplete).not.toHaveBeenCalled();
  });

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
