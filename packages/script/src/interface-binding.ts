import { CompiledScript } from './script-factory';

/**
 * 将编译后的脚本方法绑定到 TypeScript 接口。
 * 参考 jetlinks ExposedScript 的设计：脚本暴露特定方法，
 * 通过 Proxy 对象使调用方可以按接口类型安全地调用脚本函数。
 *
 * @param script 编译后的脚本（脚本中应 return 一个包含方法的对象）
 * @param interfaceKeys 需要绑定的方法名列表
 * @returns 实现了指定接口方法的代理对象
 *
 * @example
 * ```ts
 * interface Calculator {
 *   add(a: number, b: number): Promise<number>;
 *   multiply(a: number, b: number): Promise<number>;
 * }
 *
 * const script = await factory.compile({
 *   id: '1', name: 'calc', language: 'javascript',
 *   content: 'return { add: (a, b) => a + b, multiply: (a, b) => a * b }',
 * });
 *
 * const calc = bindInterface<Calculator>(script, ['add', 'multiply']);
 * await calc.add(1, 2); // 3
 * ```
 */
export function bindInterface<T extends Record<string, (...args: unknown[]) => unknown>>(
  script: CompiledScript,
  interfaceKeys: string[],
): T {
  let cachedExports: Record<string, unknown> | null = null;

  const getExports = async (): Promise<Record<string, unknown>> => {
    if (!cachedExports) {
      const result = await script.call();
      if (typeof result !== 'object' || result === null) {
        throw new Error('Script must return an object with methods');
      }
      cachedExports = result as Record<string, unknown>;
    }
    return cachedExports;
  };

  return new Proxy({} as T, {
    get(_target, prop: string) {
      if (!interfaceKeys.includes(prop)) {
        return undefined;
      }

      return async (...args: unknown[]) => {
        const exports = await getExports();
        const fn = exports[prop];
        if (typeof fn !== 'function') {
          throw new Error(`Script does not export method: ${prop}`);
        }
        return fn(...args);
      };
    },
  });
}
