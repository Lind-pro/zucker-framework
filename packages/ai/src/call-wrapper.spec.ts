import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AICallWrapper } from './call-wrapper';
import { AICallObserverRegistry } from './call-observer';
import { openAIStreamExtractor } from './openai-stream-helper';

/** 把数组转成 AsyncIterable */
async function* asAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

describe('AICallWrapper.callWithStream（A4 反哺）', () => {
  describe('callWithStream', () => {
    let wrapper: AICallWrapper;

    beforeEach(() => {
      wrapper = new AICallWrapper();
    });

    it('普通流：正确聚合 content 和 chunkCount', async () => {
      const chunks = [{ content: 'A' }, { content: 'B' }, { content: 'C' }];
      const result = await wrapper.callWithStream(
        () => Promise.resolve(asAsyncIterable(chunks)),
        (c) => c,
      );
      expect(result.content).toBe('ABC');
      expect(result.chunkCount).toBe(3);
      expect(result.usage).toBeUndefined();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('usage 提取：最后一个 chunk 带 usage', async () => {
      const chunks = [
        { content: 'hello' },
        { content: ' world' },
        { usage: { input: 10, output: 20, total: 30 } },
      ];
      const result = await wrapper.callWithStream(
        () => Promise.resolve(asAsyncIterable(chunks)),
        (c: any) => c,
      );
      expect(result.content).toBe('hello world');
      expect(result.chunkCount).toBe(3);
      expect(result.usage).toEqual({ input: 10, output: 20, total: 30 });
    });

    it('空流：返回空 content + chunkCount=0', async () => {
      const result = await wrapper.callWithStream(
        () => Promise.resolve(asAsyncIterable([])),
        (c: any) => c,
      );
      expect(result.content).toBe('');
      expect(result.chunkCount).toBe(0);
      expect(result.usage).toBeUndefined();
    });

    it('extractor 返回 {} 时 chunk 计数仍 +1，content 不变', async () => {
      const chunks = [{ noop: true }, { content: 'X' }, { noop: true }];
      const result = await wrapper.callWithStream(
        () => Promise.resolve(asAsyncIterable(chunks)),
        (c: any) => (c.content ? { content: c.content } : {}),
      );
      expect(result.content).toBe('X');
      expect(result.chunkCount).toBe(3);
    });

    it('stream 中途 throw → 错误重新抛出', async () => {
      async function* badStream() {
        yield { content: 'first' };
        throw new Error('mid-stream boom');
      }
      await expect(
        wrapper.callWithStream(() => Promise.resolve(badStream()), (c: any) => c),
      ).rejects.toThrow('mid-stream boom');
    });

    it('集成 observer：onSuccess 收到包含 result 的事件', async () => {
      const registry = new AICallObserverRegistry();
      const onSuccess = vi.fn();
      const onError = vi.fn();
      registry.register({ onSuccess, onError });
      const w = new AICallWrapper(registry);

      await w.callWithStream(
        () => Promise.resolve(asAsyncIterable([{ content: 'hi' }])),
        (c: any) => c,
        { context: 'test-stream', metadata: { foo: 'bar' } },
      );

      expect(onSuccess).toHaveBeenCalledTimes(1);
      const event = onSuccess.mock.calls[0][0];
      expect(event.context).toBe('test-stream');
      expect(event.attempt).toBe(1);
      expect(event.result.content).toBe('hi');
      expect(event.metadata).toEqual({ foo: 'bar' });
      expect(onError).not.toHaveBeenCalled();
    });

    it('集成 observer：失败时 onError 触发', async () => {
      const registry = new AICallObserverRegistry();
      const onError = vi.fn();
      registry.register({ onError });
      const w = new AICallWrapper(registry);

      await expect(
        w.callWithStream(
          () => Promise.reject(new Error('factory boom')),
          (c: any) => c,
        ),
      ).rejects.toThrow('factory boom');
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0].error.message).toBe('factory boom');
    });

    it('progressIntervalMs=0 时不打印进度（仅最终日志）', async () => {
      const w = new AICallWrapper();
      const logSpy = vi.spyOn((w as any).logger, 'log');

      const chunks = [{ content: 'a' }, { content: 'b' }];
      await w.callWithStream(
        () => Promise.resolve(asAsyncIterable(chunks)),
        (c: any) => c,
        { progressIntervalMs: 0 },
      );

      // 只有"流式完成"那一条 log，没有"进行中"
      const progressLogs = logSpy.mock.calls.filter((c) =>
        String(c[0]).includes('进行中') || String(c[0]).includes('已耗时'),
      );
      expect(progressLogs.length).toBe(0);
    });
  });

  describe('openAIStreamExtractor', () => {
    it('标准 OpenAI chunk → 提取 content', () => {
      const chunk = { choices: [{ delta: { content: 'hello' } }] };
      expect(openAIStreamExtractor(chunk)).toEqual({ content: 'hello' });
    });

    it('数组形 content → 拼接', () => {
      const chunk = {
        choices: [
          {
            delta: {
              content: [
                { text: 'a' },
                { text: 'b' },
                { text: { content: 'c' } },
                'd',
              ],
            },
          },
        ],
      };
      const result = openAIStreamExtractor(chunk);
      expect(result.content).toBe('abcd');
    });

    it('末尾 usage chunk → TokenUsage 字段对齐', () => {
      const chunk = {
        choices: [{ delta: {} }],
        usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
      };
      expect(openAIStreamExtractor(chunk)).toEqual({
        usage: { input: 100, output: 200, total: 300 },
      });
    });

    it('缺 choices → 返回空对象', () => {
      expect(openAIStreamExtractor({})).toEqual({});
    });

    it('缺 delta → 返回空对象', () => {
      expect(openAIStreamExtractor({ choices: [{}] })).toEqual({});
    });
  });
});
