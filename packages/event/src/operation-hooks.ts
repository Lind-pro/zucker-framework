import { Logger } from '@nestjs/common';

/**
 * 通用操作 Hook 系统
 *
 * 对标 Claude Code 的 PreToolUse / PostToolUse hook:
 * 允许在任意操作前后注入逻辑（审批、记录、拦截），而不限于 CRUD 事件。
 *
 * 用法:
 * ```ts
 * const hooks = new OperationHookRegistry();
 *
 * // 注册 hook: 在 storage.upload 之前执行
 * hooks.register('storage.upload', 'before', async (ctx) => {
 *   if (ctx.data.size > MAX_SIZE) ctx.cancel('文件超过大小限制');
 * });
 *
 * // 执行 hook
 * const ctx = hooks.createContext('storage.upload', { file });
 * await hooks.executeBefore(ctx);
 * if (ctx.cancelled) throw new Error(ctx.cancelReason);
 * // ... 执行实际操作 ...
 * await hooks.executeAfter(ctx);
 * ```
 */

export type HookPhase = 'before' | 'after';

export interface OperationContext {
  /** 操作名称（如 'storage.upload', 'config.update'） */
  readonly operation: string;
  /** 操作数据 */
  data: unknown;
  /** 操作是否被取消 */
  cancelled: boolean;
  /** 取消原因 */
  cancelReason?: string;
  /** 操作结果（仅在 after 阶段可用） */
  result?: unknown;
  /** 自定义属性 */
  readonly attributes: Map<string, unknown>;

  /** 取消操作 */
  cancel(reason: string): void;
}

export type HookHandler = (ctx: OperationContext) => void | Promise<void>;

interface RegisteredHook {
  operation: string; // 支持 wildcard: 'storage.*', '*'
  phase: HookPhase;
  handler: HookHandler;
  priority: number; // 数字越大越先执行
  name?: string;
}

function matchesOperation(pattern: string, operation: string): boolean {
  if (pattern === '*') return true;
  if (pattern === operation) return true;

  // Wildcard: 'storage.*' matches 'storage.upload', 'storage.delete'
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -2);
    return operation.startsWith(prefix + '.') || operation === prefix;
  }

  // Double wildcard: 'entity.**' matches 'entity.user.create.after'
  if (pattern.endsWith('.**')) {
    const prefix = pattern.slice(0, -3);
    return operation.startsWith(prefix + '.') || operation === prefix;
  }

  return false;
}

export class OperationHookRegistry {
  private readonly logger = new Logger(OperationHookRegistry.name);
  private readonly hooks: RegisteredHook[] = [];

  /**
   * 注册操作 hook
   * @param operation 操作名称模式（支持 * 和 ** 通配符）
   * @param phase 执行阶段
   * @param handler hook 处理函数
   * @param options 可选配置
   * @returns 取消注册的函数
   */
  register(
    operation: string,
    phase: HookPhase,
    handler: HookHandler,
    options?: { priority?: number; name?: string },
  ): () => void {
    const hook: RegisteredHook = {
      operation,
      phase,
      handler,
      priority: options?.priority ?? 0,
      name: options?.name,
    };
    this.hooks.push(hook);

    // 按优先级排序（高优先级先执行）
    this.hooks.sort((a, b) => b.priority - a.priority);

    return () => {
      const idx = this.hooks.indexOf(hook);
      if (idx !== -1) this.hooks.splice(idx, 1);
    };
  }

  /**
   * 创建操作上下文
   */
  createContext(operation: string, data: unknown): OperationContext {
    return {
      operation,
      data,
      cancelled: false,
      cancelReason: undefined,
      result: undefined,
      attributes: new Map(),
      cancel(reason: string) {
        this.cancelled = true;
        this.cancelReason = reason;
      },
    };
  }

  /**
   * 执行 before 阶段的所有 hook
   * 如果任意 hook 取消了操作，后续 hook 不再执行
   */
  async executeBefore(ctx: OperationContext): Promise<void> {
    await this.executePhase(ctx, 'before');
  }

  /**
   * 执行 after 阶段的所有 hook
   */
  async executeAfter(ctx: OperationContext): Promise<void> {
    await this.executePhase(ctx, 'after');
  }

  private async executePhase(ctx: OperationContext, phase: HookPhase): Promise<void> {
    const matching = this.hooks.filter(
      (h) => h.phase === phase && matchesOperation(h.operation, ctx.operation),
    );

    for (const hook of matching) {
      if (phase === 'before' && ctx.cancelled) break;

      try {
        await hook.handler(ctx);
      } catch (error) {
        const hookName = hook.name ?? hook.operation;
        this.logger.error(
          `Hook "${hookName}" (${phase}) failed for operation "${ctx.operation}": ${error}`,
        );
        // before 阶段的 hook 异常等同于取消操作
        if (phase === 'before') {
          ctx.cancel(`Hook "${hookName}" failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  /**
   * 获取已注册的 hook 数量
   */
  get size(): number {
    return this.hooks.length;
  }

  /**
   * 清除所有 hook
   */
  clear(): void {
    this.hooks.length = 0;
  }
}
