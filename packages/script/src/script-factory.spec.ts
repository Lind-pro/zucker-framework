import { describe, it, expect } from 'vitest';
import { JavaScriptScriptFactory } from './script-factory';
import type { Script } from './script-factory';
import { createExecutionContext } from './execution-context';

function makeScript(content: string): Script {
  return { id: '1', name: 'test', content, language: 'javascript' };
}

describe('JavaScriptScriptFactory', () => {
  describe('compile / call', () => {
    it('compile 返回 CompiledScript 对象', async () => {
      const factory = new JavaScriptScriptFactory();
      const compiled = await factory.compile(makeScript('return 42;'));
      expect(compiled).toBeDefined();
      expect(typeof compiled.call).toBe('function');
      expect(typeof compiled.callWithContext).toBe('function');
      expect(typeof compiled.callWithExecutionContext).toBe('function');
    });

    it('call() 执行脚本并返回结果', async () => {
      const factory = new JavaScriptScriptFactory();
      const compiled = await factory.compile(makeScript('return 1 + 1;'));
      const result = await compiled.call();
      expect(result).toBe(2);
    });

    it('call() 可通过 __args 访问参数', async () => {
      const factory = new JavaScriptScriptFactory();
      const compiled = await factory.compile(makeScript('return __args[0] + __args[1];'));
      const result = await compiled.call(3, 4);
      expect(result).toBe(7);
    });
  });

  describe('callWithContext', () => {
    it('callWithContext 将 context 注入沙箱', async () => {
      const factory = new JavaScriptScriptFactory();
      const compiled = await factory.compile(makeScript('return multiplier * 10;'));
      const result = await compiled.callWithContext({ multiplier: 5 });
      expect(result).toBe(50);
    });

    it('callWithContext 与 expose 变量同时可访问', async () => {
      const factory = new JavaScriptScriptFactory();
      const compiled = await factory.compileExpose(
        makeScript('return base + extra;'),
        { base: 100 },
      );
      const result = await compiled.callWithContext({ extra: 7 });
      expect(result).toBe(107);
    });
  });

  describe('callWithExecutionContext', () => {
    it('callWithExecutionContext 将 ExecutionContext 属性注入沙箱', async () => {
      const factory = new JavaScriptScriptFactory();
      const compiled = await factory.compile(makeScript('return greeting;'));
      const ctx = createExecutionContext({ greeting: 'hello' });
      const result = await compiled.callWithExecutionContext(ctx);
      expect(result).toBe('hello');
    });
  });

  describe('allowModule / denyModule / isDenied', () => {
    it('默认情况下所有模块都被拒绝', () => {
      const factory = new JavaScriptScriptFactory();
      expect(factory.isDenied('fs')).toBe(true);
      expect(factory.isDenied('path')).toBe(true);
    });

    it('allowModule 使模块不再被拒绝', () => {
      const factory = new JavaScriptScriptFactory();
      factory.allowModule('path');
      expect(factory.isDenied('path')).toBe(false);
    });

    it('denyModule 移除之前允许的模块', () => {
      const factory = new JavaScriptScriptFactory();
      factory.allowModule('path');
      factory.denyModule('path');
      expect(factory.isDenied('path')).toBe(true);
    });
  });

  describe('convertToJavaType', () => {
    it('null 和 undefined 原样返回', () => {
      const factory = new JavaScriptScriptFactory();
      expect(factory.convertToJavaType(null)).toBeNull();
      expect(factory.convertToJavaType(undefined)).toBeUndefined();
    });

    it('Map 转换为普通对象', () => {
      const factory = new JavaScriptScriptFactory();
      const map = new Map([['a', 1], ['b', 2]]);
      const result = factory.convertToJavaType(map);
      expect(result).toEqual({ a: 1, b: 2 });
    });

    it('Set 转换为数组', () => {
      const factory = new JavaScriptScriptFactory();
      const set = new Set([1, 2, 3]);
      const result = factory.convertToJavaType(set);
      expect(result).toEqual([1, 2, 3]);
    });

    it('Array 递归转换每个元素', () => {
      const factory = new JavaScriptScriptFactory();
      const arr = [new Map([['x', 10]]), 'plain'];
      const result = factory.convertToJavaType(arr) as unknown[];
      expect(result[0]).toEqual({ x: 10 });
      expect(result[1]).toBe('plain');
    });

    it('普通值原样返回', () => {
      const factory = new JavaScriptScriptFactory();
      expect(factory.convertToJavaType(42)).toBe(42);
      expect(factory.convertToJavaType('hello')).toBe('hello');
    });

    it('嵌套 Map 递归转换', () => {
      const factory = new JavaScriptScriptFactory();
      const nested = new Map([['inner', new Map([['deep', true]])]]);
      const result = factory.convertToJavaType(nested) as Record<string, unknown>;
      expect(result['inner']).toEqual({ deep: true });
    });
  });

  describe('createProxy', () => {
    it('createProxy 返回可按接口调用脚本方法的代理对象', async () => {
      const factory = new JavaScriptScriptFactory();
      const script = makeScript('return { double: (n) => n * 2 }');
      const proxy = await factory.createProxy<{ double: (n: unknown) => unknown }>(
        script,
        ['double'],
      );
      const result = await proxy.double(5);
      expect(result).toBe(10);
    });

    it('createProxy 对接口外的方法返回 undefined', async () => {
      const factory = new JavaScriptScriptFactory();
      const script = makeScript('return { a: () => 1, b: () => 2 }');
      const proxy = await factory.createProxy<Record<string, unknown>>(script, ['a']);
      // 'b' is not in interfaceKeys
      expect((proxy as Record<string, unknown>)['b']).toBeUndefined();
    });
  });
});
