import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
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


/**
 * Round-2 regressions. Failures such as process exit or a hang can only be observed from
 * outside, so these run in child processes with a kill timer. They load the built `dist`
 * of the script and core packages (run `pnpm build` in both after changing sources).
 */
const SCRIPT_DIST = resolve(__dirname, '../dist/index.js');
const CORE_DIST = resolve(__dirname, '../../core/dist/index.js');
const RULE_DIST = resolve(__dirname, '../../rule-engine/dist/index.js');
const haveDist = existsSync(SCRIPT_DIST);

function runChild(code: string, nodeArgs: string[] = [], killAfterMs = 15000) {
  const r = spawnSync(process.execPath, [...nodeArgs, '-e', code], { encoding: 'utf8', timeout: killAfterMs, killSignal: 'SIGKILL' });
  return { status: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '', killed: r.error != null };
}

/** Child program: run `body` then print ALIVE after a 100 ms timer. */
function aliveProgram(body: string): string {
  return `
const { createSandbox } = require(${JSON.stringify(SCRIPT_DIST)});
const sb = createSandbox({ timeout: 500, allowedModules: [], onLog: () => {} });
(async () => {
  try { ${body} } catch (e) { console.log('THROWN', String(e && e.message || e)); }
  setTimeout(() => console.log('ALIVE'), 100);
})();
`;
}

describe.skipIf(!haveDist)('unhandled rejections inside the sandbox (H1)', () => {
  const payloads: Record<string, string> = {
    'script Promise.reject': `console.log('RESULT', sb.execute('Promise.reject(new Error("boom")); return 1'));`,
    'fire-and-forget rejecting async host function': `
      console.log('RESULT', await sb.executeAsync('notify("x"); return load(1)', {
        notify: async () => { throw new Error('smtp down'); },
        load: async (n) => n,
      }));`,
    'ExpressionEvaluator with Promise.reject': `
      const { ExpressionEvaluator } = require(${JSON.stringify(RULE_DIST)});
      console.log('RESULT', new ExpressionEvaluator().evaluate({}, { expression: 'Promise.reject(1), true' }));`,
    'core evaluate of a rejecting async function': `
      const { evaluate } = require(${JSON.stringify(CORE_DIST)});
      console.log('RESULT', evaluate('(async () => { throw 1 })() && 1'));`,
  };
  for (const [name, body] of Object.entries(payloads)) {
    it(`keeps the host alive: ${name}`, () => {
      const r = runChild(aliveProgram(body));
      expect(r.killed).toBe(false);
      expect(r.stdout).toContain('ALIVE');
      expect(r.status).toBe(0);
    });
  }

  it('host-side Promise.reject() in the same process still exits non-zero (Node semantics kept)', () => {
    const r = runChild(aliveProgram(`sb.execute('return 1'); Promise.reject(new Error('host boom'));`));
    expect(r.killed).toBe(false);
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('ALIVE');
  });

  it('with --unhandled-rejections=warn-with-error-code a host rejection yields exit code 1', () => {
    const r = runChild(
      aliveProgram(`sb.execute('return 1'); Promise.reject(new Error('host boom'));`),
      ['--unhandled-rejections=warn-with-error-code'],
    );
    expect(r.killed).toBe(false);
    expect(r.status).toBe(1);
  });

  it('a script awaiting a rejecting host function still receives the error in catch', async () => {
    const result = await createSandbox({ timeout: 500, allowedModules: [], onLog: () => undefined }).executeAsync(
      'return (async () => { try { await fail(); return "no error"; } catch (e) { return "caught:" + e.message; } })()',
      { fail: async () => { throw new Error('smtp down'); } },
    );
    expect(result).toBe('caught:smtp down');
  });
});

describe('protocol hardening (H2)', () => {
  const TOJSON_POC =
    'Object.prototype.toJSON = function () { if (this.err) { for (;;) {} } if ("w" in this) return { w: 123456 }; return this; };\n' +
    'return { then() {} }';

  it.skipIf(!haveDist)('the toJSON poll PoC throws within about the timeout instead of hanging', () => {
    const code = `
const { createSandbox } = require(${JSON.stringify(SCRIPT_DIST)});
const sb = createSandbox({ timeout: 300, allowedModules: [], onLog: () => {} });
const t0 = Date.now();
try { sb.execute(${JSON.stringify(TOJSON_POC)}); console.log('RESULT no throw'); }
catch (e) { console.log('THROWN', e.message, Date.now() - t0); }
`;
    const r = runChild(code, [], 10000);
    expect(r.killed).toBe(false); // would be killed by the timer on a hang
    expect(r.stdout).toMatch(/THROWN/);
    const ms = Number(r.stdout.trim().split(' ').pop());
    expect(ms).toBeLessThan(3000);
  });

  it('Object.prototype.toJSON / Array.prototype.toJSON overrides do not change a returned value', () => {
    const result = sandbox().execute(
      'Object.prototype.toJSON = function () { return { hijacked: true }; };\n' +
        'Array.prototype.toJSON = function () { return "hijacked"; };\n' +
        'return { a: [1, 2] }',
    );
    expect(result).toEqual({ a: [1, 2] });
  });

  it('a forged { "w": 999 } reply produces an error, not a hang', () => {
    const code = `
const { createSandbox } = require(${JSON.stringify(SCRIPT_DIST)});
const sb = createSandbox({ timeout: 300, allowedModules: [], onLog: () => {} });
try { console.log('RESULT', JSON.stringify(sb.execute('Object.prototype.toJSON = function () { if ("w" in this) return { w: 999 }; return this; }; return { then() {} }'))); }
catch (e) { console.log('THROWN', e.message); }
`;
    const r = runChild(code, [], 10000);
    expect(r.killed).toBe(false);
    expect(r.stdout).toMatch(/THROWN|RESULT/);
    // A forged reply must never be accepted as a successful value of slot 999.
    expect(r.stdout).toMatch(/THROWN/);
  });
});

describe('stack traces (L11)', () => {
  it('new Error().stack only contains sandbox frames', () => {
    const stack = sandbox().execute('return new Error("x").stack') as string;
    expect(typeof stack).toBe('string');
    const frames = stack.split('\n').filter((l) => /^\s*at /.test(l));
    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) expect(f).toMatch(/sandbox-script\.js/);
    expect(stack).not.toMatch(/node_modules|packages\/script|sandbox\.(ts|js):|node:internal/);
  });

  it('assigning Error.prepareStackTrace changes nothing', () => {
    const result = sandbox().execute(
      'Error.prepareStackTrace = function () { return "PWNED"; };' +
        'var s = new Error("x").stack; return [s === "PWNED", typeof s]',
    ) as [boolean, string];
    expect(result[0]).toBe(false);
    expect(result[1]).toBe('string');
  });

  it('Error.stackTraceLimit is read-only', () => {
    const result = sandbox().execute(
      'var before = Error.stackTraceLimit; try { Error.stackTraceLimit = 1000; } catch (e) {} return Error.stackTraceLimit === before',
    );
    expect(result).toBe(true);
  });
});

describe('dynamic import and re-entrancy (L10)', () => {
  it('allows the word "import" in strings', () => {
    expect(sandbox().execute('return "import done"')).toBe('import done');
  });

  const dynamicImports: Record<string, string> = {
    'import(': 'return import("fs")',
    'import /*x*/ (': 'return import /*x*/ ("fs")',
    'import //c\\n(': 'return import //c\n("fs")',
    'import <!--\\n(': 'return import <!--\n("fs")',
    'import\\n-->\\n(': 'return import\n-->\n("fs")',
    'import.meta': 'return import.meta',
  };
  for (const [name, code] of Object.entries(dynamicImports)) {
    it(`rejects ${name}`, () => {
      expect(() => sandbox().execute(code)).toThrow(/Dynamic `import\(\)`/);
    });
  }

  it('a host function that synchronously calls a sandbox callback works', () => {
    const result = sandbox().execute('return each([1, 2, 3], function (x) { return x * 2; })', {
      each: (list: number[], fn: (x: number) => number) => list.map((x) => fn(x)),
    });
    expect(result).toEqual([2, 4, 6]);
  });

  it('a nested infinite loop in a re-entrant callback times out', () => {
    expect(() =>
      createSandbox({ timeout: 300, allowedModules: [], onLog: () => undefined }).execute(
        'return each([1], function () { for (;;) {} })',
        { each: (list: number[], fn: (x: number) => unknown) => list.map((x) => fn(x)) },
      ),
    ).toThrow(/timed out/);
  });
});

describe('exposeMethods (L12)', () => {
  class Svc {
    value = 5;
    secret() { return 'secret'; }
  }

  it('with exposeMethods: false an instance method is undefined but own data is readable', () => {
    const sb = createSandbox({ timeout: 500, allowedModules: [], onLog: () => undefined, exposeMethods: false });
    const result = sb.execute('return [typeof svc.secret, svc.value]', { svc: new Svc() });
    expect(result).toEqual(['undefined', 5]);
  });

  it('by default instance methods are still exposed', () => {
    const result = sandbox().execute('return [typeof svc.secret, svc.secret(), svc.value]', { svc: new Svc() });
    expect(result).toEqual(['function', 'secret', 5]);
  });
});

describe('host-function table', () => {
  // SandboxRealm (and its hostFns table) is private to a single execute() call, so growth cannot
  // be observed directly. This exercises the code path (the same instance re-encoded on every
  // callback invocation) and checks it keeps working and returns correct values.
  it('re-encoding the same instance on every callback invocation keeps working', () => {
    const svc = new (class { ping() { return 1; } })();
    const fn = sandbox().execute('return function (o) { return o.ping(); }') as (o: unknown) => number;
    let sum = 0;
    for (let i = 0; i < 2000; i++) sum += fn(svc);
    expect(sum).toBe(2000);
  });
});
