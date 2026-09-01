/**
 * Context — 类型安全上下文容器
 * 参考: hsweb-framework Context.java, ContextKey.java, MapContext.java, ContextUtils.java
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 类型安全的上下文键
 * 对比 hsweb ContextKey: 增加便捷工厂方法 string/integer/bool
 */
export class ContextKey<T> {
  constructor(
    public readonly name: string,
    public readonly defaultValue?: T,
  ) {}

  static of<T>(name: string, defaultValue?: T): ContextKey<T> {
    return new ContextKey<T>(name, defaultValue);
  }

  /** 便捷方法 — 字符串键（参考 hsweb ContextKey.string） */
  static string(name: string, defaultValue?: string): ContextKey<string> {
    return new ContextKey<string>(name, defaultValue);
  }

  /** 便捷方法 — 数字键（参考 hsweb ContextKey.integer） */
  static number(name: string, defaultValue?: number): ContextKey<number> {
    return new ContextKey<number>(name, defaultValue);
  }

  /** 便捷方法 — 布尔键（参考 hsweb ContextKey.bool） */
  static bool(name: string, defaultValue?: boolean): ContextKey<boolean> {
    return new ContextKey<boolean>(name, defaultValue);
  }
}

export interface Context {
  get<T>(key: ContextKey<T>): T | undefined;
  /**
   * 获取值，不存在则使用 defaultValue 创建并存储
   * 参考 hsweb: T getOrDefault(ContextKey<T> key, Supplier<? extends T> defaultValue)
   */
  getOrDefault<T>(key: ContextKey<T>, defaultValue: () => T): T;
  set<T>(key: ContextKey<T>, value: T): void;
  remove<T>(key: ContextKey<T>): T | undefined;
  has<T>(key: ContextKey<T>): boolean;
  clear(): void;
  getAll(): Map<string, unknown>;
}

/**
 * 基于 Map 的 Context 实现
 * 对比 hsweb MapContext: 增加 getOrDefault 支持（computeIfAbsent 语义）
 */
export class MapContext implements Context {
  private readonly store = new Map<string, unknown>();

  get<T>(key: ContextKey<T>): T | undefined {
    const value = this.store.get(key.name) as T | undefined;
    if (value === undefined && key.defaultValue !== undefined) {
      return key.defaultValue;
    }
    return value;
  }

  getOrDefault<T>(key: ContextKey<T>, defaultValue: () => T): T {
    if (this.store.has(key.name)) {
      return this.store.get(key.name) as T;
    }
    const value = defaultValue();
    this.store.set(key.name, value);
    return value;
  }

  set<T>(key: ContextKey<T>, value: T): void {
    this.store.set(key.name, value);
  }

  remove<T>(key: ContextKey<T>): T | undefined {
    const value = this.store.get(key.name) as T | undefined;
    this.store.delete(key.name);
    return value;
  }

  has<T>(key: ContextKey<T>): boolean {
    return this.store.has(key.name);
  }

  clear(): void {
    this.store.clear();
  }

  getAll(): Map<string, unknown> {
    return new Map(this.store);
  }
}

/**
 * 基于 AsyncLocalStorage 的全局上下文持有器
 * 用于在异步调用链中共享上下文
 *
 * 对比 hsweb ContextUtils:
 * - hsweb 使用 ThreadLocal<Context> 和 Reactor Context
 * - zucker 使用 AsyncLocalStorage（Node.js 对应方案）
 */
export class ContextHolder {
  private static readonly storage = new AsyncLocalStorage<Context>();

  /** 获取当前上下文 */
  static current(): Context | undefined {
    return this.storage.getStore();
  }

  /** 获取当前上下文，如果不存在则抛出错误 */
  static require(): Context {
    const ctx = this.current();
    if (!ctx) throw new Error('No context available in current async scope');
    return ctx;
  }

  /** 在上下文中执行回调 */
  static run<R>(ctx: Context, fn: () => R): R {
    return this.storage.run(ctx, fn);
  }

  /** 使用新 MapContext 执行回调 */
  static runWithNew<R>(fn: () => R): R {
    return this.run(new MapContext(), fn);
  }

  /**
   * 从当前上下文获取值的快捷方法
   * 参考 hsweb ContextUtils.currentContext().get(key)
   */
  static get<T>(key: ContextKey<T>): T | undefined {
    return this.current()?.get(key);
  }

  /**
   * 向当前上下文设置值的快捷方法
   */
  static set<T>(key: ContextKey<T>, value: T): void {
    const ctx = this.current();
    if (ctx) {
      ctx.set(key, value);
    }
  }
}
