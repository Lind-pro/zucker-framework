import type { CostTracker, CostRecord } from './cost-tracker';

/**
 * @TrackAIUsage 装饰器选项。
 *
 * 各字段都接受静态值或动态函数 —— 让用户灵活适配任何返回结构。
 */
export interface TrackUsageOptions<TArgs extends any[] = any[], TResult = unknown> {
  /** 从方法参数提取场景标识 */
  scenario: (args: TArgs) => string | undefined;

  /**
   * 从方法返回值提取 token 用量。
   * 返回 undefined 时跳过记录（如返回值非标准 AI 响应）。
   */
  extractUsage: (
    result: TResult,
  ) => Pick<CostRecord, 'inputTokens' | 'outputTokens' | 'totalTokens'> | undefined;

  /** Provider id（字符串或动态函数）*/
  provider: string | ((args: TArgs) => string);

  /** Model id（字符串或动态函数，可读 result 字段）*/
  model: string | ((args: TArgs, result: TResult) => string);

  /** 从参数提取 userId，可选 */
  userId?: (args: TArgs) => string | undefined;

  /**
   * 成本计算函数（每 1k token 价格自定义）。
   * 不提供时记 0（事后可按 provider+model 反推）。
   */
  cost?: (
    usage: { inputTokens: number; outputTokens: number },
    model: string,
  ) => number;
}

/**
 * 方法装饰器：自动把 AI 调用的成本推送到 CostTracker。
 *
 * **宿主类约束**：必须有 `costTracker` 字段（NestJS 注入或子类提供）。
 * 字段不存在时静默跳过（不报错），便于灰度。
 *
 * **错误吞掉策略**：装饰器内部任何错误都被静默 —— 成本追踪不能搞挂业务。
 *
 * @example
 * ```ts
 * class FooService {
 *   constructor(@Inject(CostTracker) private readonly costTracker: CostTracker) {}
 *
 *   @TrackAIUsage({
 *     scenario: (args) => args[0],
 *     extractUsage: (r) => r.usage ? {
 *       inputTokens: r.usage.prompt_tokens,
 *       outputTokens: r.usage.completion_tokens,
 *       totalTokens: r.usage.total_tokens,
 *     } : undefined,
 *     provider: 'openai',
 *     model: (a, r) => r.model,
 *     cost: (u, m) => calculateCost(u, m),
 *   })
 *   async chat(scenario: string, messages: any[]) { ... }
 * }
 * ```
 */
export function TrackAIUsage<TArgs extends any[] = any[], TResult = unknown>(
  options: TrackUsageOptions<TArgs, TResult>,
): MethodDecorator {
  return function (_target, _propertyKey, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (this: any, ...args: TArgs) {
      const startTime = Date.now();
      const result: TResult = await originalMethod.apply(this, args);

      try {
        const tracker: CostTracker | undefined = this.costTracker;
        if (!tracker) return result;

        const usage = options.extractUsage(result);
        if (!usage) return result;

        const provider =
          typeof options.provider === 'function' ? options.provider(args) : options.provider;
        const model =
          typeof options.model === 'function' ? options.model(args, result) : options.model;
        const cost = options.cost ? options.cost(usage, model) : 0;

        tracker.record({
          timestamp: Date.now(),
          provider,
          model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          cost,
          scenario: options.scenario(args),
          userId: options.userId?.(args),
          duration: Date.now() - startTime,
        });
      } catch {
        // 静默：成本追踪不能影响主流程
      }

      return result;
    };

    return descriptor;
  };
}
