import type { ExecutionContext } from './execution-context';

/**
 * 暴露脚本接口 — 对齐 jetlinks ExposedScript<T>。
 *
 * 提供支持暴露实例方法的脚本执行。脚本可以直接调用
 * 暴露实例的方法，而不需要通过变量传参。
 */
export interface ExposedScript<T> {
  /**
   * 使用指定的暴露实例和上下文来执行脚本。
   * 对齐 jetlinks ExposedScript.call(T expose, ExecutionContext context)。
   */
  call(expose: T, context?: ExecutionContext): Promise<unknown>;

  /**
   * 使用指定的暴露实例和简单 Map 上下文来执行脚本。
   * 对齐 jetlinks ExposedScript.call(T expose, Map context)。
   */
  callWithMap(expose: T, context?: Record<string, unknown>): Promise<unknown>;
}

/**
 * 暴露给脚本沙箱的方法注册表
 * 允许将 TypeScript 方法注册为沙箱中可调用的函数
 */
export class ExposedScriptRegistry {
  private methods = new Map<string, (...args: unknown[]) => unknown>();

  register(name: string, fn: (...args: unknown[]) => unknown): void {
    this.methods.set(name, fn);
  }

  unregister(name: string): void {
    this.methods.delete(name);
  }

  getExposedMethods(): Record<string, (...args: unknown[]) => unknown> {
    const result: Record<string, (...args: unknown[]) => unknown> = {};
    for (const [name, fn] of this.methods) {
      result[name] = fn;
    }
    return result;
  }

  has(name: string): boolean {
    return this.methods.has(name);
  }

  getNames(): string[] {
    return Array.from(this.methods.keys());
  }
}
