/**
 * ScopedContext — 强类型 AsyncLocalStorage 工厂
 *
 * 为 agent 编排、batch job、cron 等场景提供独立 storage 的
 * 强类型上下文容器。每个 scope 内部独立 `AsyncLocalStorage<T>`，
 * 不共享。
 *
 * 与 `MapContext` / `ContextHolder` 区别：
 * - `MapContext` 用 `ContextKey<T>` 做弱类型 string lookup，适合
 *   把 HTTP 请求级元数据（locale / correlationId / ip）混合放一处。
 * - `ScopedContext<T>` 用强类型 `T`，适合「单一领域」的状态对象
 *   （如 `DossierContextData`、`BatchJobContext`），不允许 unrelated
 *   key 混入。
 *
 * 用法：
 * ```ts
 * interface DossierData { dossierId: string; userId: string; snapshot: ... }
 * export const DossierContext = createScopedContext<DossierData>('dossier');
 *
 * // orchestrator 入口
 * await DossierContext.run({ dossierId, userId, snapshot }, async () => {
 *   await agent.run(); // agent 内部 DossierContext.required()
 * });
 *
 * // agent 里
 * const { dossierId } = DossierContext.required();
 * const dossierId = DossierContext.pick('dossierId'); // 等价快捷
 * ```
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface ScopedContext<T> {
  /** 在新 context 内执行 fn，fn 返回值原样回传 */
  run<R>(data: T, fn: () => Promise<R>): Promise<R>;
  run<R>(data: T, fn: () => R): R;

  /** 读当前 context；不在 scope 内返回 undefined */
  current(): T | undefined;

  /** 读当前 context；不在 scope 内抛错（错误信息含 scopeName） */
  required(): T;

  /** `required()[key]` 的快捷方式 */
  pick<K extends keyof T>(key: K): T[K];

  /** scope 名（用于错误信息和调试） */
  readonly name: string;
}

export function createScopedContext<T>(scopeName: string): ScopedContext<T> {
  const storage = new AsyncLocalStorage<T>();

  function run<R>(data: T, fn: () => R | Promise<R>): R | Promise<R> {
    return storage.run(data, fn) as R | Promise<R>;
  }

  return {
    name: scopeName,
    run: run as ScopedContext<T>['run'],
    current(): T | undefined {
      return storage.getStore();
    },
    required(): T {
      const ctx = storage.getStore();
      if (!ctx) {
        throw new Error(
          `ScopedContext '${scopeName}' 缺失：当前调用栈不在 ${scopeName} run() 内部`,
        );
      }
      return ctx;
    },
    pick<K extends keyof T>(key: K): T[K] {
      const ctx = storage.getStore();
      if (!ctx) {
        throw new Error(
          `ScopedContext '${scopeName}' 缺失：当前调用栈不在 ${scopeName} run() 内部`,
        );
      }
      return ctx[key];
    },
  };
}
