import { describe, it, expect, vi } from 'vitest';
import { ExposedScriptRegistry } from './exposed-script';

describe('ExposedScriptRegistry', () => {
  it('register 注册方法后 has 返回 true', () => {
    const registry = new ExposedScriptRegistry();
    registry.register('greet', () => 'hello');
    expect(registry.has('greet')).toBe(true);
  });

  it('has 对未注册的名称返回 false', () => {
    const registry = new ExposedScriptRegistry();
    expect(registry.has('nonexistent')).toBe(false);
  });

  it('getExposedMethods 返回所有已注册方法的 Record', () => {
    const registry = new ExposedScriptRegistry();
    const fn1 = vi.fn(() => 1);
    const fn2 = vi.fn(() => 2);
    registry.register('fn1', fn1);
    registry.register('fn2', fn2);
    const methods = registry.getExposedMethods();
    expect(typeof methods.fn1).toBe('function');
    expect(typeof methods.fn2).toBe('function');
  });

  it('getExposedMethods 返回的方法可以被调用', () => {
    const registry = new ExposedScriptRegistry();
    registry.register('add', (a: unknown, b: unknown) => (a as number) + (b as number));
    const methods = registry.getExposedMethods();
    expect(methods.add(3, 4)).toBe(7);
  });

  it('unregister 移除方法后 has 返回 false', () => {
    const registry = new ExposedScriptRegistry();
    registry.register('temp', () => 'x');
    registry.unregister('temp');
    expect(registry.has('temp')).toBe(false);
  });

  it('unregister 后 getExposedMethods 中不再包含该方法', () => {
    const registry = new ExposedScriptRegistry();
    registry.register('keep', () => 'keep');
    registry.register('remove', () => 'remove');
    registry.unregister('remove');
    const methods = registry.getExposedMethods();
    expect(methods.keep).toBeDefined();
    expect(methods.remove).toBeUndefined();
  });

  it('getNames 返回所有已注册名称数组', () => {
    const registry = new ExposedScriptRegistry();
    registry.register('alpha', () => 'a');
    registry.register('beta', () => 'b');
    const names = registry.getNames();
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
    expect(names).toHaveLength(2);
  });

  it('重复注册同名方法会覆盖旧方法', () => {
    const registry = new ExposedScriptRegistry();
    registry.register('compute', () => 'old');
    registry.register('compute', () => 'new');
    const methods = registry.getExposedMethods();
    expect(methods.compute()).toBe('new');
  });

  it('多个注册表实例相互独立', () => {
    const r1 = new ExposedScriptRegistry();
    const r2 = new ExposedScriptRegistry();
    r1.register('onlyInR1', () => 'r1');
    expect(r1.has('onlyInR1')).toBe(true);
    expect(r2.has('onlyInR1')).toBe(false);
  });
});
