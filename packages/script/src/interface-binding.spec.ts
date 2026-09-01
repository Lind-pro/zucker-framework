import { describe, it, expect } from 'vitest';
import { bindInterface } from './interface-binding';
import type { CompiledScript } from './script-factory';

/** 创建一个模拟 CompiledScript，call() 返回预设的导出对象 */
function makeCompiledScript(exports: Record<string, unknown>): CompiledScript {
  return {
    call: async () => exports,
    callWithContext: async () => exports,
    callWithExecutionContext: async () => exports,
  };
}

describe('bindInterface', () => {
  it('代理对象可调用 interfaceKeys 中声明的方法', async () => {
    const script = makeCompiledScript({ add: (a: unknown, b: unknown) => (a as number) + (b as number) });
    const proxy = bindInterface<{ add: (a: unknown, b: unknown) => unknown }>(script, ['add']);
    const result = await proxy.add(3, 5);
    expect(result).toBe(8);
  });

  it('访问 interfaceKeys 之外的属性返回 undefined', async () => {
    const script = makeCompiledScript({ foo: () => 'foo', bar: () => 'bar' });
    const proxy = bindInterface<Record<string, unknown>>(script, ['foo']);
    expect((proxy as Record<string, unknown>)['bar']).toBeUndefined();
  });

  it('脚本未导出对象时抛出错误', async () => {
    const script: CompiledScript = {
      call: async () => 'not an object',
      callWithContext: async () => null,
      callWithExecutionContext: async () => null,
    };
    const proxy = bindInterface<{ fn: () => unknown }>(script, ['fn']);
    await expect(proxy.fn()).rejects.toThrow('Script must return an object with methods');
  });

  it('脚本导出对象中缺少声明方法时抛出错误', async () => {
    const script = makeCompiledScript({ other: () => 'other' });
    const proxy = bindInterface<{ missing: () => unknown }>(script, ['missing']);
    await expect(proxy.missing()).rejects.toThrow('Script does not export method: missing');
  });

  it('缓存脚本执行结果：多次调用只执行一次 call()', async () => {
    let callCount = 0;
    const script: CompiledScript = {
      call: async () => {
        callCount++;
        return { fn: () => 'ok' };
      },
      callWithContext: async () => ({}),
      callWithExecutionContext: async () => ({}),
    };
    const proxy = bindInterface<{ fn: () => unknown }>(script, ['fn']);
    await proxy.fn();
    await proxy.fn();
    expect(callCount).toBe(1);
  });

  it('多个接口方法均可独立调用', async () => {
    const script = makeCompiledScript({
      double: (n: unknown) => (n as number) * 2,
      triple: (n: unknown) => (n as number) * 3,
    });
    const proxy = bindInterface<{
      double: (n: unknown) => unknown;
      triple: (n: unknown) => unknown;
    }>(script, ['double', 'triple']);
    expect(await proxy.double(4)).toBe(8);
    expect(await proxy.triple(4)).toBe(12);
  });
});
