import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'crypto';

/**
 * 认证用户信息（最小化接口，不依赖 @zucker-framework/auth 具体实现）
 */
export interface ContextUser {
  id: string;
  username: string;
  name?: string;
  roles?: string[];
}

/**
 * 统一请求上下文
 *
 * 对标 Claude Code 的 AppState Store 模式：
 * 所有组件共享同一份上下文快照，通过 AsyncLocalStorage 在整个调用链中传播。
 *
 * 用途：
 * - 替代分散的 @CurrentUser()、TenantInterceptor、LocaleInterceptor
 * - 让 Service 层无需注入 REQUEST scope provider 即可获取用户/租户信息
 * - 为日志、审计、监控提供统一的关联上下文
 */
export class RequestContext {
  /** 请求唯一标识，用于跨服务追踪 */
  readonly correlationId: string;

  /** 请求开始时间 */
  readonly startTime: number;

  /** 认证用户 */
  user?: ContextUser;

  /** 租户 ID（多租户场景） */
  tenantId?: string;

  /** 请求 locale */
  locale: string;

  /** 请求来源 IP */
  ip?: string;

  /** 请求路径 */
  path?: string;

  /** 请求方法 */
  method?: string;

  /** 自定义属性存储 */
  private readonly _attributes = new Map<string, unknown>();

  constructor(init?: Partial<Pick<RequestContext, 'correlationId' | 'user' | 'tenantId' | 'locale' | 'ip' | 'path' | 'method'>>) {
    this.correlationId = init?.correlationId ?? randomUUID();
    this.startTime = Date.now();
    this.user = init?.user;
    this.tenantId = init?.tenantId;
    this.locale = init?.locale ?? 'zh-CN';
    this.ip = init?.ip;
    this.path = init?.path;
    this.method = init?.method;
  }

  /** 获取请求耗时（毫秒） */
  get elapsed(): number {
    return Date.now() - this.startTime;
  }

  /** 设置自定义属性 */
  setAttribute(key: string, value: unknown): void {
    this._attributes.set(key, value);
  }

  /** 获取自定义属性 */
  getAttribute<T = unknown>(key: string): T | undefined {
    return this._attributes.get(key) as T | undefined;
  }

  /** 转为可序列化的日志上下文 */
  toLogContext(): Record<string, unknown> {
    return {
      correlationId: this.correlationId,
      userId: this.user?.id,
      username: this.user?.username,
      tenantId: this.tenantId,
      locale: this.locale,
      ip: this.ip,
      path: this.path,
      method: this.method,
      elapsed: this.elapsed,
    };
  }

  // ─── Static API: AsyncLocalStorage 驱动 ──────────────────────────

  private static readonly storage = new AsyncLocalStorage<RequestContext>();

  /** 获取当前请求上下文（如果不在请求内则返回 undefined） */
  static current(): RequestContext | undefined {
    return RequestContext.storage.getStore();
  }

  /** 获取当前请求上下文（如果不在请求内则抛出异常） */
  static currentOrFail(): RequestContext {
    const ctx = RequestContext.storage.getStore();
    if (!ctx) {
      throw new Error(
        'RequestContext not available. Ensure RequestContextMiddleware is applied.',
      );
    }
    return ctx;
  }

  /** 在指定上下文中执行函数 */
  static run<T>(ctx: RequestContext, fn: () => T): T {
    return RequestContext.storage.run(ctx, fn);
  }

  /** 创建新上下文并执行函数 */
  static runNew<T>(init: Partial<Pick<RequestContext, 'correlationId' | 'user' | 'tenantId' | 'locale' | 'ip' | 'path' | 'method'>>, fn: () => T): T {
    return RequestContext.storage.run(new RequestContext(init), fn);
  }

  // ─── 向后兼容：correlation ID 快捷访问 ────────────────────────────

  /** 获取当前 correlationId（兼容旧的 getCorrelationId()） */
  static getCorrelationId(): string | undefined {
    return RequestContext.current()?.correlationId;
  }
}
