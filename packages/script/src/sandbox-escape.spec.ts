import { describe, it, expect, vi } from 'vitest';
import { createSandbox } from './sandbox';

/**
 * Regression tests for realm escapes reported against the vm-based sandbox
 * (review finding C1). Each payload tries to reach the host `process`.
 */
const sandbox = () => createSandbox({ timeout: 500, allowedModules: [], onLog: () => undefined });

const PAYLOADS: Record<string, string> = {
  'console.log.constructor': 'return console.log.constructor("return process")()',
  'this.constructor.constructor': 'return this.constructor.constructor("return process")()',
  'bare constructor.constructor': 'return constructor.constructor("return process")()',
  'injected object': 'return host.constructor.constructor("return process")()',
  'injected function': 'return fn.constructor("return process")()',
  'injected method': 'return svc.ping.constructor("return process")()',
  'string-concatenated property': 'var c = "constr" + "uctor"; return data[c][c]("return pro" + "cess")()',
  'error from host function': 'try { boom(); } catch (e) { return e.constructor.constructor("return process")(); }',
  'host function return value': 'var v = getObj(); return v.constructor.constructor("return process")()',
  'Function via __proto__': 'return data.__proto__.constructor.constructor("return process")()',
  'eval': 'return eval("process")',
};

function context() {
  return {
    host: { a: 1 },
    data: { nested: { x: 1 } },
    fn: () => 1,
    svc: new (class Svc { ping() { return 'pong'; } })(),
    boom: () => { throw new Error('host failure'); },
    getObj: () => ({ y: 2 }),
  };
}

describe('createSandbox escape regressions', () => {
  for (const [name, code] of Object.entries(PAYLOADS)) {
    it(`does not reach host process via ${name}`, () => {
      let result: unknown;
      try {
        result = sandbox().execute(code, context());
      } catch (error) {
        // Throwing (code generation disabled / not a function) is the expected outcome.
        expect(String(error)).not.toMatch(/^\[object process\]/);
        return;
      }
      expect(result).not.toBe(process);
      expect(typeof (result as { pid?: unknown } | undefined)?.pid).not.toBe('number');
    });
  }

  it('rejects dynamic import()', () => {
    expect(() => sandbox().execute('return import("fs")')).toThrow(/import/);
  });

  it('host values copied in are not host objects', () => {
    const result = sandbox().execute(
      'return [Object.getPrototypeOf(data) === Object.prototype, typeof data.nested.x]',
      context(),
    );
    expect(result).toEqual([true, 'number']);
  });

  it('host functions receive copies and their errors are sandbox errors', () => {
    const seen: unknown[] = [];
    const result = sandbox().execute(
      'record({ a: [1, 2] }); try { boom(); } catch (e) { return [e instanceof Error, e.message]; }',
      { record: (v: unknown) => seen.push(v), boom: () => { throw new Error('host failure'); } },
    );
    expect(seen).toEqual([{ a: [1, 2] }]);
    expect(result).toEqual([true, 'host failure']);
  });

  it('host function return values are copied as structured values', () => {
    expect(sandbox().execute('var v = getObj(); return [typeof v, v.y]', context())).toEqual(['object', 2]);
  });

  it('bounds infinite synchronous loops', () => {
    expect(() => sandbox().execute('for (;;) {}')).toThrow(/timed out/);
  });

  it('bounds infinite microtask loops (async work)', () => {
    expect(() =>
      sandbox().execute('(async () => { for (;;) await null; })(); return 1;'),
    ).toThrow(/timed out/);
  });

  it('resolves sandbox-only promises synchronously', () => {
    expect(sandbox().execute('return Promise.resolve(2).then(v => v * 21)')).toBe(42);
  });

  it('a never-settling promise fails instead of hanging', () => {
    expect(() => sandbox().execute('return new Promise(() => {})')).toThrow(/never settles/);
  });

  it('timers and scheduling primitives are unavailable', () => {
    expect(
      sandbox().execute(
        'return [typeof setTimeout, typeof queueMicrotask, typeof FinalizationRegistry, typeof WeakRef, typeof SharedArrayBuffer]',
      ),
    ).toEqual(['undefined', 'undefined', 'undefined', 'undefined', 'undefined']);
  });

  it('executeAsync awaits asynchronous host functions within the timeout', async () => {
    const result = await sandbox().executeAsync(
      'return load(3).then(v => v + 1)',
      { load: async (n: number) => n * 10 },
    );
    expect(result).toBe(31);
  });

  it('executeAsync times out when a host promise does not settle', async () => {
    await expect(
      createSandbox({ timeout: 100, allowedModules: [] }).executeAsync('return wait()', {
        wait: () => new Promise(() => undefined),
      }),
    ).rejects.toThrow(/timed out/);
  });

  it('returned sandbox functions run under the timeout', () => {
    const fn = sandbox().execute('return function () { for (;;) {} }') as () => unknown;
    expect(() => fn()).toThrow(/timed out/);
  });

  it('preserves Map/Set/Date results', () => {
    const r = sandbox().execute('return { m: new Map([["a", 1]]), s: new Set([1]), d: new Date(5) }') as {
      m: Map<string, number>; s: Set<number>; d: Date;
    };
    expect(r.m).toBeInstanceOf(Map);
    expect(r.m.get('a')).toBe(1);
    expect(r.s).toBeInstanceOf(Set);
    expect(r.d.getTime()).toBe(5);
  });

  it('routes console output to onLog', () => {
    const onLog = vi.fn();
    createSandbox({ timeout: 500, allowedModules: [], onLog }).execute('console.warn("hi", { a: 1 })');
    expect(onLog).toHaveBeenCalledWith('warn', 'hi {"a":1}');
  });
});
