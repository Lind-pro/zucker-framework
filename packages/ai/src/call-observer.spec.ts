import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AICallWrapper } from './call-wrapper';
import {
  AICallObserverRegistry,
  type AICallObserver,
  type AICallSuccessEvent,
  type AICallErrorEvent,
} from './call-observer';

describe('AICallObserver + Registry（A3 反哺）', () => {
  describe('AICallObserverRegistry', () => {
    it('register / getAll / count', () => {
      const reg = new AICallObserverRegistry();
      expect(reg.count).toBe(0);
      const obs1: AICallObserver = { onSuccess: vi.fn() };
      const obs2: AICallObserver = { onError: vi.fn() };
      reg.register(obs1);
      reg.register(obs2);
      expect(reg.count).toBe(2);
      expect(reg.getAll()).toEqual([obs1, obs2]);
    });

    it('unregister 返回 true 当存在，false 当不存在', () => {
      const reg = new AICallObserverRegistry();
      const obs: AICallObserver = { onSuccess: vi.fn() };
      reg.register(obs);
      expect(reg.unregister(obs)).toBe(true);
      expect(reg.unregister(obs)).toBe(false);
      expect(reg.count).toBe(0);
    });

    it('clear 清空全部', () => {
      const reg = new AICallObserverRegistry();
      reg.register({ onSuccess: vi.fn() });
      reg.register({ onError: vi.fn() });
      reg.clear();
      expect(reg.count).toBe(0);
    });
  });

  describe('AICallWrapper 集成 observer', () => {
    let registry: AICallObserverRegistry;
    let wrapper: AICallWrapper;

    beforeEach(() => {
      registry = new AICallObserverRegistry();
      wrapper = new AICallWrapper(registry);
    });

    it('不注入 registry 时 callWithRetry 正常工作（向后兼容）', async () => {
      const w = new AICallWrapper();
      const result = await w.callWithRetry(async () => 42);
      expect(result).toBe(42);
    });

    it('单 observer：成功路径触发 onSuccess', async () => {
      const onSuccess = vi.fn();
      registry.register({ onSuccess });
      await wrapper.callWithRetry(async () => 'hello', {
        context: 'test',
        metadata: { tag: 'unit' },
      });

      expect(onSuccess).toHaveBeenCalledTimes(1);
      const event: AICallSuccessEvent = onSuccess.mock.calls[0][0];
      expect(event.context).toBe('test');
      expect(event.attempt).toBe(1);
      expect(event.result).toBeUndefined();
      expect(event.metadata).toEqual({ tag: 'unit' });
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('只有显式 opt-in 才把完整结果交给 observer', async () => {
      const onSuccess = vi.fn();
      registry.register({ onSuccess });
      await wrapper.callWithRetry(async () => 'sensitive-result', {
        observerResult: 'full',
      });

      expect(onSuccess.mock.calls[0][0].result).toBe('sensitive-result');
    });

    it('多个 observer 顺序遍历', async () => {
      const calls: number[] = [];
      registry.register({
        onSuccess: () => {
          calls.push(1);
        },
      });
      registry.register({
        onSuccess: () => {
          calls.push(2);
        },
      });
      registry.register({
        onSuccess: () => {
          calls.push(3);
        },
      });

      await wrapper.callWithRetry(async () => 1);
      expect(calls).toEqual([1, 2, 3]);
    });

    it('observer 抛错时其他 observer 仍被通知', async () => {
      const onSuccess1 = vi.fn(() => {
        throw new Error('observer 1 boom');
      });
      const onSuccess2 = vi.fn();
      registry.register({ onSuccess: onSuccess1 });
      registry.register({ onSuccess: onSuccess2 });

      await wrapper.callWithRetry(async () => 'ok');
      expect(onSuccess1).toHaveBeenCalled();
      expect(onSuccess2).toHaveBeenCalled();
    });

    it('observer 抛错不影响主返回值', async () => {
      registry.register({
        onSuccess: () => {
          throw new Error('boom');
        },
      });
      const result = await wrapper.callWithRetry(async () => 'ok');
      expect(result).toBe('ok');
    });

    it('失败路径只触发 onError，成功路径只触发 onSuccess', async () => {
      const onSuccess = vi.fn();
      const onError = vi.fn();
      registry.register({ onSuccess, onError });

      await wrapper.callWithRetry(async () => 'good');
      expect(onSuccess).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();

      onSuccess.mockClear();
      await expect(
        wrapper.callWithRetry(
          async () => {
            throw new Error('bad');
          },
          { maxAttempts: 1 },
        ),
      ).rejects.toThrow('bad');
      expect(onSuccess).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledTimes(1);

      const errEvent: AICallErrorEvent = onError.mock.calls[0][0];
      expect(errEvent.error.message).toBe('bad');
      expect(errEvent.attempt).toBe(1);
    });

    it('重试时每次 attempt 都触发 onError', async () => {
      const onError = vi.fn();
      registry.register({ onError });

      await expect(
        wrapper.callWithRetry(
          async () => {
            throw new Error('flaky');
          },
          {
            maxAttempts: 3,
            baseDelayMs: 1,
          },
        ),
      ).rejects.toThrow('flaky');

      // 3 次 attempt 都应触发
      expect(onError).toHaveBeenCalledTimes(3);
      expect(onError.mock.calls[0][0].attempt).toBe(1);
      expect(onError.mock.calls[1][0].attempt).toBe(2);
      expect(onError.mock.calls[2][0].attempt).toBe(3);
    });

    it('metadata 字段正确传递', async () => {
      const onSuccess = vi.fn();
      registry.register({ onSuccess });
      await wrapper.callWithRetry(async () => 'ok', {
        metadata: { dossierId: 'd-123', stage: 'vision', userId: 'u-456' },
      });
      expect(onSuccess.mock.calls[0][0].metadata).toEqual({
        dossierId: 'd-123',
        stage: 'vision',
        userId: 'u-456',
      });
    });

    it('observer 不实现某个钩子时跳过（不报错）', async () => {
      // 只实现 onSuccess，没有 onError
      registry.register({ onSuccess: vi.fn() });
      // 应该不抛错
      await expect(
        wrapper.callWithRetry(
          async () => {
            throw new Error('x');
          },
          { maxAttempts: 1 },
        ),
      ).rejects.toThrow('x');
    });
  });
});
