import { AsyncLocalStorage } from 'node:async_hooks';

interface TenantStore {
  tenantId: string;
  /** Explicit system access across tenants (see runWithoutTenantIsolation). */
  bypassIsolation?: boolean;
  /** 附加属性，如租户名称、配置等 */
  attributes?: Record<string, unknown>;
}

const tenantStorage = new AsyncLocalStorage<TenantStore>();

/**
 * 租户上下文 — 通过 AsyncLocalStorage 绑定当前租户 ID
 *
 * 对应 Java 多租户体系中的 TenantContext，提供上下文绑定、
 * 嵌套切换和属性存取能力。
 */
export class TenantContext {
  /**
   * 获取当前租户 ID
   */
  static getCurrentTenantId(): string | undefined {
    return tenantStorage.getStore()?.tenantId || undefined;
  }

  /**
   * 获取当前租户上下文中的属性
   */
  static getAttribute<T = unknown>(key: string): T | undefined {
    return tenantStorage.getStore()?.attributes?.[key] as T | undefined;
  }

  /**
   * 设置当前租户上下文中的属性
   */
  static setAttribute(key: string, value: unknown): void {
    const store = tenantStorage.getStore();
    if (!store) return;
    if (!store.attributes) store.attributes = {};
    store.attributes[key] = value;
  }

  /**
   * 判断当前是否在租户上下文中
   */
  static isInTenantContext(): boolean {
    return !!tenantStorage.getStore()?.tenantId;
  }

  /**
   * 在指定租户上下文中执行操作
   */
  static runWithTenant<T>(tenantId: string, fn: () => T): T {
    return tenantStorage.run({ tenantId }, fn);
  }

  /**
   * 在指定租户上下文中执行异步操作
   */
  static async runWithTenantAsync<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return tenantStorage.run({ tenantId }, fn);
  }

  /**
   * Run `fn` as explicit cross-tenant system access (jobs, migrations, admin tooling).
   * `RowLevelIsolation` does not filter inside this scope instead of throwing.
   */
  static runWithoutTenantIsolation<T>(fn: () => T): T {
    return tenantStorage.run({ tenantId: '', bypassIsolation: true }, fn);
  }

  /** True inside `runWithoutTenantIsolation` (and not inside a nested tenant scope). */
  static isTenantIsolationBypassed(): boolean {
    return tenantStorage.getStore()?.bypassIsolation === true;
  }

  /**
   * 在指定租户上下文中执行操作，并携带属性
   */
  static runWithTenantAndAttributes<T>(
    tenantId: string,
    attributes: Record<string, unknown>,
    fn: () => T,
  ): T {
    return tenantStorage.run({ tenantId, attributes }, fn);
  }
}

/**
 * 获取当前租户 ID（快捷函数）
 */
export function getCurrentTenantId(): string | undefined {
  return TenantContext.getCurrentTenantId();
}

/**
 * 设置当前租户 ID（在 AsyncLocalStorage 中运行）
 */
export function setCurrentTenantId<T>(tenantId: string, fn: () => T): T {
  return TenantContext.runWithTenant(tenantId, fn);
}
