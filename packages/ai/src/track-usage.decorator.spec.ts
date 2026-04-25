import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TrackAIUsage } from './track-usage.decorator';
import type { CostTracker } from './cost-tracker';

function makeTracker(): CostTracker {
  return {
    record: vi.fn(),
    getTotalCost: vi.fn(),
    getTotalTokens: vi.fn(),
    getCallCount: vi.fn(),
    getStatsByProvider: vi.fn(),
    getStatsByUser: vi.fn(),
    getRecentRecords: vi.fn(),
    clear: vi.fn(),
  } as any;
}

describe('@TrackAIUsage 装饰器（A6 反哺）', () => {
  let tracker: CostTracker;

  beforeEach(() => {
    tracker = makeTracker();
  });

  it('装饰后方法返回值不变', async () => {
    class S {
      costTracker = tracker;
      @TrackAIUsage({
        scenario: () => 'scn',
        extractUsage: () => ({ inputTokens: 10, outputTokens: 20, totalTokens: 30 }),
        provider: 'openai',
        model: 'gpt-4o-mini',
      })
      async run(_x: number) {
        return { ok: true, value: 42 };
      }
    }
    const s = new S();
    const result = await s.run(1);
    expect(result).toEqual({ ok: true, value: 42 });
  });

  it('extractUsage 提供时 record 被调，参数完整', async () => {
    class S {
      costTracker = tracker;
      @TrackAIUsage({
        scenario: (args: any[]) => args[0],
        extractUsage: () => ({ inputTokens: 100, outputTokens: 200, totalTokens: 300 }),
        provider: 'openai',
        model: 'gpt-4o',
        userId: (args: any[]) => args[1],
        cost: (u) => u.inputTokens * 0.001 + u.outputTokens * 0.002,
      })
      async run(_scn: string, _user: string) {
        return {};
      }
    }
    const s = new S();
    await s.run('code-gen', 'user-123');
    expect(tracker.record).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai',
        model: 'gpt-4o',
        inputTokens: 100,
        outputTokens: 200,
        totalTokens: 300,
        scenario: 'code-gen',
        userId: 'user-123',
        cost: 0.5, // 100 * 0.001 + 200 * 0.002 = 0.5
      }),
    );
  });

  it('extractUsage 返回 undefined 时跳过 record', async () => {
    class S {
      costTracker = tracker;
      @TrackAIUsage({
        scenario: () => 'scn',
        extractUsage: () => undefined,
        provider: 'openai',
        model: 'gpt',
      })
      async run() {
        return {};
      }
    }
    await new S().run();
    expect(tracker.record).not.toHaveBeenCalled();
  });

  it('宿主类无 costTracker 字段时静默跳过', async () => {
    class S {
      @TrackAIUsage({
        scenario: () => 'scn',
        extractUsage: () => ({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }),
        provider: 'openai',
        model: 'gpt',
      })
      async run() {
        return { ok: true };
      }
    }
    const result = await new S().run();
    expect(result).toEqual({ ok: true });
  });

  it('provider/model 静态字符串', async () => {
    class S {
      costTracker = tracker;
      @TrackAIUsage({
        scenario: () => 's',
        extractUsage: () => ({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }),
        provider: 'deepseek',
        model: 'deepseek-chat',
      })
      async run() { return {}; }
    }
    await new S().run();
    expect(tracker.record).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'deepseek', model: 'deepseek-chat' }),
    );
  });

  it('provider/model 动态函数', async () => {
    class S {
      costTracker = tracker;
      @TrackAIUsage({
        scenario: () => 's',
        extractUsage: () => ({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }),
        provider: (args: any[]) => `prov-${args[0]}`,
        model: (args: any[], result: any) => `${args[0]}-${result.modelHint}`,
      })
      async run(_p: string) {
        return { modelHint: 'v1' };
      }
    }
    await new S().run('test');
    expect(tracker.record).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'prov-test', model: 'test-v1' }),
    );
  });

  it('装饰器内部错误不影响主返回值（mock tracker.record throw）', async () => {
    (tracker.record as any).mockImplementation(() => {
      throw new Error('tracker boom');
    });
    class S {
      costTracker = tracker;
      @TrackAIUsage({
        scenario: () => 's',
        extractUsage: () => ({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }),
        provider: 'p',
        model: 'm',
      })
      async run() {
        return { ok: 1 };
      }
    }
    const result = await new S().run();
    expect(result).toEqual({ ok: 1 });
  });

  it('cost 字段缺失时记 0', async () => {
    class S {
      costTracker = tracker;
      @TrackAIUsage({
        scenario: () => 's',
        extractUsage: () => ({ inputTokens: 5, outputTokens: 10, totalTokens: 15 }),
        provider: 'p',
        model: 'm',
      })
      async run() {
        return {};
      }
    }
    await new S().run();
    expect(tracker.record).toHaveBeenCalledWith(expect.objectContaining({ cost: 0 }));
  });
});
