import { describe, it, expect } from 'vitest';
import { createSandbox } from './sandbox';

describe('createSandbox', () => {
  it('执行简单表达式并返回结果', () => {
    const sandbox = createSandbox({ timeout: 1000, allowedModules: [] });
    const result = sandbox.execute('return 1 + 2');
    expect(result).toBe(3);
  });

  it('可访问注入的上下文变量', () => {
    const sandbox = createSandbox({ timeout: 1000, allowedModules: [] });
    const result = sandbox.execute('return x * 2', { x: 7 });
    expect(result).toBe(14);
  });

  it('context 对象多个变量均可访问', () => {
    const sandbox = createSandbox({ timeout: 1000, allowedModules: [] });
    const result = sandbox.execute('return a + b', { a: 10, b: 20 });
    expect(result).toBe(30);
  });

  it('全局 process 在沙箱中为 undefined', () => {
    const sandbox = createSandbox({ timeout: 1000, allowedModules: [] });
    const result = sandbox.execute('return typeof process');
    expect(result).toBe('undefined');
  });

  it('全局 require 在沙箱中为 undefined（无允许模块时）', () => {
    const sandbox = createSandbox({ timeout: 1000, allowedModules: [] });
    const result = sandbox.execute('return typeof require');
    expect(result).toBe('undefined');
  });

  it('全局 globalThis 在沙箱中为 undefined', () => {
    const sandbox = createSandbox({ timeout: 1000, allowedModules: [] });
    const result = sandbox.execute('return typeof globalThis');
    expect(result).toBe('undefined');
  });

  it('执行不返回值时结果为 undefined', () => {
    const sandbox = createSandbox({ timeout: 1000, allowedModules: [] });
    const result = sandbox.execute('var x = 1;');
    expect(result).toBeUndefined();
  });

  it('语法错误抛出异常', () => {
    const sandbox = createSandbox({ timeout: 1000, allowedModules: [] });
    expect(() => sandbox.execute('return {{{')).toThrow();
  });

  it('运行时错误抛出异常', () => {
    const sandbox = createSandbox({ timeout: 1000, allowedModules: [] });
    expect(() => sandbox.execute('throw new Error("boom")')).toThrow('boom');
  });

  it('require 在沙箱中始终为 undefined（BLOCKED_GLOBALS 覆盖 allowedModules）', () => {
    // createRestrictedRequire 注入的 require 会被 BLOCKED_GLOBALS 循环覆盖为 undefined
    // 因此即使 allowedModules 非空，沙箱内 require 也不可调用
    const sandbox = createSandbox({ timeout: 1000, allowedModules: ['path'] });
    const result = sandbox.execute('return typeof require');
    expect(result).toBe('undefined');
  });

  it('require 不可用时调用它会抛出包含 "not a function" 的错误', () => {
    const sandbox = createSandbox({ timeout: 1000, allowedModules: ['path'] });
    expect(() => sandbox.execute('return require("path")')).toThrow('not a function');
  });

  it('多次独立调用 createSandbox 互不影响', () => {
    const s1 = createSandbox({ timeout: 1000, allowedModules: [] });
    const s2 = createSandbox({ timeout: 1000, allowedModules: [] });
    s1.execute('var shared = 1;');
    const result = s2.execute('return typeof shared');
    // shared is not defined in s2's context
    expect(result).toBe('undefined');
  });

  it('沙箱中 console 可用（不抛出）', () => {
    const sandbox = createSandbox({ timeout: 1000, allowedModules: [] });
    expect(() => sandbox.execute('console.log("test")')).not.toThrow();
  });
});
