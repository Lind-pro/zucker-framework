import vm from 'node:vm';
import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';

/**
 * SECURITY MODEL — read before exposing this to anyone but trusted operators.
 *
 * Node's `vm` module is NOT a security boundary. This sandbox is hardened so that the
 * known escape classes do not work (see `sandbox.spec.ts` for the regression payloads):
 *
 * - No host-realm object is ever placed in the context. The global is backed by a
 *   null-prototype object, `console` and all helpers are created inside the context realm,
 *   data is copied in and out through a tagged JSON encoding, and host functions are reached
 *   only through context-realm wrappers that exchange strings with a single host bridge.
 *   Errors from host functions are re-created inside the context realm.
 * - `codeGeneration: { strings: false, wasm: false }` disables `eval`, `Function(...)` and
 *   WebAssembly compilation inside the context, so even a context-realm `Function` cannot
 *   compile code.
 * - Scripts containing dynamic `import(...)` or `import.meta` are rejected (Node rejects
 *   dynamic `import()` with a host-realm error object). The word `import` elsewhere (strings,
 *   identifiers such as `importDone`) is allowed.
 * - `microtaskMode: 'afterEvaluate'` makes promise jobs run inside the same timeout as the
 *   synchronous part; there are no timers, so an `async` script cannot keep running after
 *   the call returns. `FinalizationRegistry`, `WeakRef`, `Atomics` and `SharedArrayBuffer`
 *   are removed so nothing can schedule work outside the timeout.
 * - The host never calls a context function outside `runInContext({ timeout })` once user code
 *   has run (results are polled through a trampoline script), and protocol replies are
 *   serialised without `JSON.stringify`, so `toJSON` overrides cannot run code or forge replies.
 * - A rejected promise left unhandled inside the context would be reported process-wide and, in
 *   Node's default mode, terminate the host. `createSandbox` installs a process-level guard
 *   (`installSandboxRejectionGuard`) that ignores (logs) rejections of promises from vm realms
 *   and keeps Node's default behaviour for host promises.
 *
 * Remaining limits: there is no memory cap (a script can allocate until the host process
 * runs out of heap) and V8/Node bugs can still break realm isolation. Code from untrusted
 * users (tenants, end users) must be run behind an isolate or process boundary
 * (e.g. `isolated-vm`, or a worker/child process with resource limits and a hard kill).
 */
export interface SandboxOptions {
  /** Wall-clock budget per call in milliseconds (synchronous part, promise jobs and, for async calls, host promises). */
  timeout: number;
  /**
   * @deprecated Ignored. `require` is never available inside the sandbox because a host
   * module object would give scripts full access to the host process.
   */
  allowedModules: string[];
  name?: string;
  /** Receives `console.*` output of scripts. Defaults to a Nest `Logger`. */
  onLog?: (level: SandboxLogLevel, message: string) => void;
  /**
   * Class instances (objects whose prototype is not `Object.prototype`/`null`) passed into the
   * sandbox expose their methods, including prototype and "private" methods, bound to the
   * instance (default true, the historical behaviour). With `false` only their own enumerable
   * non-function properties are copied, so a service-like object in the data cannot be called.
   * Plain objects and top-level context functions are unaffected.
   */
  exposeMethods?: boolean;
}

export type SandboxLogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface Sandbox {
  /**
   * Runs `code` as a function body (use `return` to produce a result). Context values are
   * copied into the sandbox; host functions are callable through wrappers. The result is
   * copied back (Map/Set/Date/RegExp/typed arrays are preserved; functions become host
   * callables that re-enter the sandbox under the same timeout). A promise result is
   * resolved synchronously when it only depends on sandbox code; use `executeAsync` when
   * host functions are asynchronous.
   */
  execute(code: string, context?: Record<string, unknown>): unknown;
}

export interface AsyncSandbox extends Sandbox {
  /** Like `execute`, but also awaits promises returned by exposed host functions (bounded by `timeout`). */
  executeAsync(code: string, context?: Record<string, unknown>): Promise<unknown>;
}

/** Globals that are always `undefined` inside the sandbox. */
const BLOCKED_GLOBALS = [
  'process', 'require', 'module', 'exports', '__filename', '__dirname',
  'globalThis', 'global', 'root', 'GLOBAL',
  'setTimeout', 'setInterval', 'setImmediate',
  'clearTimeout', 'clearInterval', 'clearImmediate',
  'queueMicrotask', 'FinalizationRegistry', 'WeakRef', 'Atomics',
  'SharedArrayBuffer', 'WebAssembly',
] as const;

const MAX_DEPTH = 200;
const MAX_LOG_LENGTH = 8192;
/**
 * Dynamic `import(...)` / `import.meta`, also with whitespace or any comment form between
 * `import` and `(`/`.`.
 * Node rejects `import()` in a context without `importModuleDynamically` using a host-realm
 * error object, which would expose the host `Function` constructor, so these forms must never
 * reach the compiler. A plain word `import` (e.g. inside a string) is allowed.
 */
// Gap: whitespace, block comments, `//` comments and Annex B HTML-like comments (`<!--`, `-->`).
const DYNAMIC_IMPORT =
  /\bimport(?:\s|\/\*[\s\S]*?\*\/|(?:\/\/|<!--|-->)[^\n\r\u2028\u2029]*)*[(.]/;

/**
 * Context-realm bootstrap. Runs before any user code, captures the intrinsics it needs and
 * returns an `init(bridge)` function. The bridge (the only host function the context ever
 * sees) is kept in this closure and only receives/returns primitives.
 */
const BOOTSTRAP = `(function (g) {
'use strict';
const O = Object;
const defineProperty = O.defineProperty;
const freeze = O.freeze;
const keys = O.keys;
const create = O.create;
const getPrototypeOf = O.getPrototypeOf;
const hasOwn = O.prototype.hasOwnProperty;
const isPrototypeOf = O.prototype.isPrototypeOf;
const apply = Reflect.apply;
const isArray = Array.isArray;
const ArrayC = Array;
const JSONparse = JSON.parse;
const JSONstringify = JSON.stringify;
const StringC = String;
const MapC = Map; const SetC = Set; const DateC = Date; const RegExpC = RegExp;
const ErrorC = Error; const TypeErrorC = TypeError; const PromiseC = Promise; const U8 = Uint8Array;
const mapSize = O.getOwnPropertyDescriptor(MapC.prototype, 'size').get;
const setSize = O.getOwnPropertyDescriptor(SetC.prototype, 'size').get;
const mapForEach = MapC.prototype.forEach; const mapSet = MapC.prototype.set;
const mapGet = MapC.prototype.get; const mapHas = MapC.prototype.has; const mapDelete = MapC.prototype.delete;
const setForEach = SetC.prototype.forEach; const setAdd = SetC.prototype.add;
const setHas = SetC.prototype.has; const setDelete = SetC.prototype.delete;
const dateGetTime = DateC.prototype.getTime;
const reSource = O.getOwnPropertyDescriptor(RegExpC.prototype, 'source').get;
const reFlags = O.getOwnPropertyDescriptor(RegExpC.prototype, 'flags').get;
const typedProto = getPrototypeOf(U8.prototype);
const typedTag = O.getOwnPropertyDescriptor(typedProto, Symbol.toStringTag).get;
const typedBuffer = O.getOwnPropertyDescriptor(typedProto, 'buffer').get;
const typedOffset = O.getOwnPropertyDescriptor(typedProto, 'byteOffset').get;
const typedByteLength = O.getOwnPropertyDescriptor(typedProto, 'byteLength').get;
const promiseThen = PromiseC.prototype.then;
const promiseResolve = PromiseC.resolve;
const errorProto = ErrorC.prototype;
const MAX_DEPTH = ${MAX_DEPTH};

function put(o, k, v) { defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true }); }
// Serialises the protocol trees built by this bootstrap (strings, finite numbers, booleans, null,
// arrays and plain objects with own data properties). Unlike JSON.stringify it never looks up
// toJSON (which user code can define on Object.prototype / Array.prototype), so a script cannot
// change or forge a protocol reply. JSON.stringify is only applied to string/number primitives,
// for which no user code runs.
function ser(v) {
  const t = typeof v;
  if (t === 'string') return JSONstringify(v);
  if (t === 'number') return v === v && v !== 1 / 0 && v !== -1 / 0 ? JSONstringify(v) : 'null';
  if (t === 'boolean') return v ? 'true' : 'false';
  if (v === null || t !== 'object') return 'null';
  let s;
  if (isArray(v)) {
    s = '[';
    const n = v.length;
    for (let i = 0; i < n; i++) s += (i ? ',' : '') + ser(v[i]);
    return s + ']';
  }
  s = '{';
  const ks = keys(v);
  for (let i = 0; i < ks.length; i++) s += (i ? ',' : '') + JSONstringify(ks[i]) + ':' + ser(v[ks[i]]);
  return s + '}';
}
function brand(fn, v) { try { apply(fn, v, []); return true; } catch (e) { return false; } }

return function init(bridge, apiName) {
  const ctxFns = new MapC();
  let nextFnId = 1;
  const pendingHost = new MapC();
  const slots = new MapC();
  let nextSlot = 1;
  let staged;

  function callBridge(op, a, b) {
    let r;
    try { r = bridge(op, a, b); } catch (e) { r = undefined; }
    if (typeof r !== 'string' && r !== undefined) r = undefined;
    return r;
  }

  function registerFn(fn) {
    const id = nextFnId++;
    apply(mapSet, ctxFns, [id, fn]);
    return id;
  }

  function enc(v, d, seen) {
    if (d > MAX_DEPTH) throw new ErrorC('Value is nested too deeply');
    const t = typeof v;
    if (t === 'string' || t === 'boolean') return v;
    if (v === null) return null;
    if (t === 'number') {
      if (v !== v) return { $: 'n', v: 'NaN' };
      if (v === 1 / 0) return { $: 'n', v: 'Infinity' };
      if (v === -1 / 0) return { $: 'n', v: '-Infinity' };
      if (v === 0 && 1 / v < 0) return { $: 'n', v: '-0' };
      return v;
    }
    if (t === 'undefined' || t === 'symbol') return { $: 'u' };
    if (t === 'bigint') return { $: 'b', v: StringC(v) };
    if (t === 'function') return { $: 'f', v: registerFn(v) };
    if (apply(setHas, seen, [v])) throw new TypeErrorC('Cannot transfer a circular structure');
    apply(setAdd, seen, [v]);
    try {
      if (isArray(v)) {
        const out = [];
        const n = v.length;
        for (let i = 0; i < n; i++) put(out, i, enc(v[i], d + 1, seen));
        return { $: 'a', v: out };
      }
      if (brand(dateGetTime, v)) { const ms = apply(dateGetTime, v, []); return { $: 'd', v: ms === ms ? ms : null }; }
      if (brand(mapSize, v)) {
        const out = [];
        apply(mapForEach, v, [function (val, key) { put(out, out.length, [enc(key, d + 1, seen), enc(val, d + 1, seen)]); }]);
        return { $: 'm', v: out };
      }
      if (brand(setSize, v)) {
        const out = [];
        apply(setForEach, v, [function (val) { put(out, out.length, enc(val, d + 1, seen)); }]);
        return { $: 's', v: out };
      }
      if (brand(reSource, v)) return { $: 'r', v: apply(reSource, v, []), f: apply(reFlags, v, []) };
      if (apply(typedTag, v, []) !== undefined) {
        const bytes = new U8(apply(typedBuffer, v, []), apply(typedOffset, v, []), apply(typedByteLength, v, []));
        const out = [];
        for (let i = 0; i < bytes.length; i++) put(out, i, bytes[i]);
        return { $: 'y', v: out };
      }
      if (apply(isPrototypeOf, errorProto, [v])) {
        return { $: 'e', n: StringC(v.name), m: StringC(v.message) };
      }
      const out = [];
      const ks = keys(v);
      for (let i = 0; i < ks.length; i++) put(out, i, [ks[i], enc(v[ks[i]], d + 1, seen)]);
      return { $: 'o', v: out };
    } finally {
      apply(setDelete, seen, [v]);
    }
  }

  function encode(v) { return ser(enc(v, 0, new SetC())); }

  function makeHostFn(id) {
    const f = function () {
      const n = arguments.length;
      const args = new ArrayC();
      for (let i = 0; i < n; i++) put(args, i, arguments[i]);
      const r = callBridge('call', id, encode(args));
      return fromHostReply(r);
    };
    return freeze(f);
  }

  function dec(node, d) {
    if (d > MAX_DEPTH) throw new ErrorC('Value is nested too deeply');
    if (node === null || typeof node !== 'object') return node;
    const tag = node.$;
    const v = node.v;
    switch (tag) {
      case 'u': return undefined;
      case 'n': return v === 'NaN' ? NaN : v === 'Infinity' ? 1 / 0 : v === '-Infinity' ? -1 / 0 : -0;
      case 'b': return BigInt(v);
      case 'f': return makeHostFn(v);
      case 'd': return new DateC(v === null ? NaN : v);
      case 'r': return new RegExpC(v, node.f);
      case 'y': return new U8(v);
      case 'e': { const e = new ErrorC(node.m); defineProperty(e, 'name', { value: node.n, writable: true, configurable: true }); return e; }
      case 'a': { const out = new ArrayC(); for (let i = 0; i < v.length; i++) put(out, i, dec(v[i], d + 1)); return out; }
      case 's': { const out = new SetC(); for (let i = 0; i < v.length; i++) apply(setAdd, out, [dec(v[i], d + 1)]); return out; }
      case 'm': { const out = new MapC(); for (let i = 0; i < v.length; i++) apply(mapSet, out, [dec(v[i][0], d + 1), dec(v[i][1], d + 1)]); return out; }
      case 'o': { const out = {}; for (let i = 0; i < v.length; i++) put(out, v[i][0], dec(v[i][1], d + 1)); return out; }
      default: throw new ErrorC('Invalid value from host');
    }
  }

  function decode(json) { return dec(JSONparse(json), 0); }

  function makeError(err) {
    const e = new ErrorC(typeof err.m === 'string' ? err.m : 'Host function failed');
    if (typeof err.n === 'string') defineProperty(e, 'name', { value: err.n, writable: true, configurable: true });
    return e;
  }

  function fromHostReply(r) {
    if (r === undefined) throw new ErrorC('Host function call failed');
    const o = JSONparse(r);
    if (apply(hasOwn, o, ['ok'])) return dec(o.ok, 0);
    if (apply(hasOwn, o, ['p'])) {
      const id = o.p;
      const p = new PromiseC(function (resolve, reject) { apply(mapSet, pendingHost, [id, [resolve, reject]]); });
      // A fire-and-forget host call that fails must not count as an unhandled rejection
      // (V8 reports those process-wide). The script still sees the rejection when it awaits p.
      apply(promiseThen, p, [undefined, function () {}]);
      return p;
    }
    throw makeError(o.err || {});
  }

  function errReply(e) {
    let n = 'Error';
    let m;
    try {
      if (e !== null && (typeof e === 'object' || typeof e === 'function')) {
        const name = e.name; const message = e.message;
        if (typeof name === 'string') n = name;
        m = typeof message === 'string' ? message : StringC(e);
      } else {
        m = StringC(e);
      }
    } catch (x) { m = 'Script error'; }
    return ser({ err: { n: n, m: m } });
  }

  function okReply(v) {
    try { return ser({ ok: enc(v, 0, new SetC()) }); } catch (e) { return errReply(e); }
  }

  function callAndReply(fn, args) {
    let r;
    try { r = apply(fn, undefined, args); } catch (e) { return errReply(e); }
    let thenable = false;
    try { thenable = r !== null && (typeof r === 'object' || typeof r === 'function') && typeof r.then === 'function'; }
    catch (e) { return errReply(e); }
    if (!thenable) return okReply(r);
    const k = nextSlot++;
    apply(mapSet, slots, [k, undefined]);
    let p;
    try { p = apply(promiseResolve, PromiseC, [r]); } catch (e) { return errReply(e); }
    apply(promiseThen, p, [
      function (v) { apply(mapSet, slots, [k, okReply(v)]); },
      function (e) { apply(mapSet, slots, [k, errReply(e)]); },
    ]);
    return ser({ w: k });
  }

  function takeStaged() { const s = staged; staged = undefined; return s; }

  function logFn(level) {
    return function () {
      let text = '';
      for (let i = 0; i < arguments.length; i++) {
        const a = arguments[i];
        let s;
        try { s = typeof a === 'string' ? a : JSONstringify(a); } catch (e) { s = undefined; }
        if (s === undefined) { try { s = StringC(a); } catch (e) { s = '[unprintable]'; } }
        text += (i ? ' ' : '') + s;
        if (text.length > ${MAX_LOG_LENGTH}) break;
      }
      callBridge('log', level, text.slice(0, ${MAX_LOG_LENGTH}));
    };
  }

  const consoleObj = create(null);
  put(consoleObj, 'log', freeze(logFn('log')));
  put(consoleObj, 'info', freeze(logFn('info')));
  put(consoleObj, 'warn', freeze(logFn('warn')));
  put(consoleObj, 'error', freeze(logFn('error')));
  put(consoleObj, 'debug', freeze(logFn('debug')));
  defineProperty(g, 'console', { value: freeze(consoleObj), writable: true, configurable: true });

  // Stack traces: only frames of sandbox code are shown, so host file paths (and the host
  // frames' CallSites) are not observable through \`new Error().stack\`. Node consults the
  // context's global Error.prepareStackTrace, so both it and the global Error binding are fixed.
  const errorToString = ErrorC.prototype.toString;
  const startsWith = StringC.prototype.startsWith;
  function prepareStackTrace(err, frames) {
    let out;
    try { out = apply(errorToString, err, []); } catch (e) { out = 'Error'; }
    for (let i = 0; i < frames.length; i++) {
      let file;
      try { file = frames[i].getFileName(); } catch (e) { file = undefined; }
      if (typeof file === 'string' && apply(startsWith, file, ['sandbox-script'])) {
        let line = '';
        try { line = ':' + StringC(frames[i].getLineNumber()) + ':' + StringC(frames[i].getColumnNumber()); } catch (e) { line = ''; }
        out += '\\n    at ' + file + line;
      }
    }
    return out;
  }
  defineProperty(ErrorC, 'prepareStackTrace', { value: freeze(prepareStackTrace), writable: false, configurable: false });
  defineProperty(ErrorC, 'stackTraceLimit', { value: ErrorC.stackTraceLimit, writable: false, configurable: false });
  defineProperty(g, 'Error', { value: ErrorC, writable: false, configurable: false });

  const api = create(null);
  api.define = function (name, json) {
    defineProperty(g, name, { value: json === undefined ? undefined : decode(json), writable: true, configurable: true, enumerable: false });
  };
  api.stage = function (json) { staged = typeof json === 'string' ? json : undefined; };
  api.run = function (fn) {
    let args = g.__args;
    if (typeof args === 'undefined') args = [];
    return callAndReply(fn, [args]);
  };
  api.invoke = function () {
    const s = takeStaged();
    if (s === undefined) return errReply(new ErrorC('Nothing staged'));
    let fn; let args;
    try { const o = JSONparse(s); fn = apply(mapGet, ctxFns, [o.id]); args = decode(o.args); }
    catch (e) { return errReply(e); }
    if (typeof fn !== 'function') return errReply(new ErrorC('Unknown sandbox function'));
    return callAndReply(fn, args);
  };
  api.settle = function () {
    const s = takeStaged();
    if (s === undefined) return;
    const o = JSONparse(s);
    const entry = apply(mapGet, pendingHost, [o.p]);
    if (!entry) return;
    apply(mapDelete, pendingHost, [o.p]);
    if (apply(hasOwn, o, ['ok'])) {
      let v; let failed = false; let err;
      try { v = dec(o.ok, 0); } catch (e) { failed = true; err = e; }
      if (failed) entry[1](err); else entry[0](v);
    } else {
      entry[1](makeError(o.err || {}));
    }
  };
  api.poll = function () {
    const s = takeStaged();
    const k = s === undefined ? 0 : +s;
    if (!apply(mapHas, slots, [k])) return ser({ err: { n: 'Error', m: 'Unknown result slot' } });
    const r = apply(mapGet, slots, [k]);
    if (r !== undefined) apply(mapDelete, slots, [k]);
    return r;
  };
  freeze(api);
  // Non-writable/non-configurable so trampoline scripts cannot be redirected by user code.
  defineProperty(g, apiName, { value: api, writable: false, configurable: false, enumerable: false });
  return api;
};
})(this)`;


/** Compiled once per process; a vm.Script can run in any context. */
let compiledBootstrap: vm.Script | undefined;
function bootstrapScript(): vm.Script {
  compiledBootstrap ??= new vm.Script(BOOTSTRAP, { filename: 'sandbox-bootstrap.js' });
  return compiledBootstrap;
}

interface ContextApi {
  define(name: string, json: string | undefined): void;
  stage(json: string): void;
  /** Only called directly while a `runInContext` call is active (nested host → sandbox calls). */
  invoke(): unknown;
  poll(): unknown;
}

interface HostCallable {
  fn: (...args: unknown[]) => unknown;
  thisArg: unknown;
}

class SandboxRealm {
  private readonly context: vm.Context;
  private readonly api: ContextApi;
  private readonly apiName: string;
  private readonly invokeScript: vm.Script;
  private readonly settleScript: vm.Script;
  private readonly pollScript: vm.Script;
  private readonly hostFns: HostCallable[] = [];
  private readonly hostFnIds = new Map<(...args: unknown[]) => unknown, number>();
  /** Ids of methods bound to an instance, so re-encoding the same object does not grow hostFns. */
  private readonly boundHostFnIds = new WeakMap<object, Map<(...args: unknown[]) => unknown, number>>();
  private readonly settled: string[] = [];
  private readonly waiters = new Set<() => void>();
  private outstandingHost = 0;
  private nextHostPromise = 1;
  private active = false;
  private broken = false;

  constructor(
    private readonly options: SandboxOptions,
    private readonly logger: Logger,
  ) {
    this.context = vm.createContext(Object.create(null), {
      name: options.name ? `sandbox:${options.name}` : 'sandbox',
      codeGeneration: { strings: false, wasm: false },
      microtaskMode: 'afterEvaluate',
    });
    const init = bootstrapScript().runInContext(this.context, { timeout: 1000 }) as (
      bridge: (op: unknown, a: unknown, b: unknown) => string | undefined,
      apiName: string,
    ) => ContextApi;
    this.apiName = `__zk_${randomBytes(8).toString('hex')}`;
    this.api = init((op, a, b) => this.bridge(op, a, b), this.apiName);
    this.invokeScript = this.compile(`${this.apiName}.invoke()`, 'sandbox-invoke.js');
    this.settleScript = this.compile(`${this.apiName}.settle()`, 'sandbox-settle.js');
    this.pollScript = this.compile(`${this.apiName}.poll()`, 'sandbox-poll.js');
    for (const key of BLOCKED_GLOBALS) {
      this.api.define(key, undefined);
    }
  }

  private compile(source: string, filename: string): vm.Script {
    return new vm.Script(source, { filename });
  }

  /** Main entry: runs user code. */
  runMain(code: string, context: Record<string, unknown>, deadline: number): string {
    if (DYNAMIC_IMPORT.test(code)) {
      throw new Error('Dynamic `import()` and `import.meta` are not allowed in sandbox scripts');
    }
    for (const [key, value] of Object.entries(context)) {
      this.api.define(key, this.encodeHost(value));
    }
    const script = new vm.Script(
      `${this.apiName}.run(function (__args) {\n${code}\n})`,
      { filename: 'sandbox-script.js' },
    );
    return this.runScript(script, deadline);
  }

  invoke(id: number, args: unknown[], deadline: number): string {
    this.api.stage(JSON.stringify({ id, args: this.encodeHost(args) }));
    if (this.active) {
      // Nested call: a host function called from the sandbox synchronously calls a sandbox
      // callback (e.g. `each(list, fn)`). The outer `runInContext` is still on the stack, so its
      // timeout also bounds this call; a new `runInContext` would not be allowed here.
      const reply = this.api.invoke();
      if (reply === undefined) return JSON.stringify({ ok: { $: 'u' } });
      if (typeof reply !== 'string') throw new Error('Invalid sandbox reply');
      return reply;
    }
    return this.runScript(this.invokeScript, deadline);
  }

  /** Resolves a reply into a value, or returns a slot id when it is still pending. */
  readReply(reply: string): { done: true; value: unknown } | { done: false; slot: number } {
    const parsed = JSON.parse(reply) as { ok?: unknown; err?: { n?: unknown; m?: unknown }; w?: unknown };
    if (Object.prototype.hasOwnProperty.call(parsed, 'ok')) {
      return { done: true, value: this.decodeHost(parsed.ok, 0) };
    }
    if (typeof parsed.w === 'number') return { done: false, slot: parsed.w };
    throw this.toHostError(parsed.err);
  }

  /**
   * Reads a result slot. Runs inside `runInContext` with the call's remaining budget: once user
   * code has run, the context's intrinsics are user-controlled, so no context function may be
   * called from the host outside the vm timeout (only `api.stage`, a plain assignment, is).
   */
  pollSlot(slot: number, deadline: number): string | undefined {
    this.api.stage(String(slot));
    // Nested (see invoke): still inside the outer runInContext and its timeout.
    const r = this.active ? this.api.poll() : this.runRaw(this.pollScript, deadline);
    if (r !== undefined && typeof r !== 'string') throw new Error('Invalid sandbox reply');
    return r;
  }

  /** Delivers settled host promises into the context. Returns true when anything was delivered. */
  deliverSettled(deadline: number): boolean {
    let delivered = false;
    while (this.settled.length > 0) {
      const next = this.settled.shift() as string;
      this.api.stage(next);
      this.runScript(this.settleScript, deadline);
      delivered = true;
    }
    return delivered;
  }

  hasOutstandingHostWork(): boolean {
    return this.outstandingHost > 0 || this.settled.length > 0;
  }

  waitForHost(deadline: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        reject(this.timeoutError());
        return;
      }
      const timer = setTimeout(() => {
        this.waiters.delete(wake);
        reject(this.timeoutError());
      }, remaining);
      timer.unref?.();
      const wake = () => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve();
      };
      this.waiters.add(wake);
    });
  }

  timeoutError(): Error {
    return new Error(`Script execution timed out after ${this.options.timeout}ms`);
  }

  private runScript(script: vm.Script, deadline: number): string {
    const result = this.runRaw(script, deadline);
    if (result === undefined) return JSON.stringify({ ok: { $: 'u' } });
    if (typeof result !== 'string') throw new Error('Invalid sandbox reply');
    return result;
  }

  private runRaw(script: vm.Script, deadline: number): unknown {
    if (this.broken) throw new Error('Sandbox is no longer usable after a previous timeout');
    if (this.active) throw new Error('Re-entrant sandbox calls are not supported');
    const remaining = Math.max(1, deadline - Date.now());
    this.active = true;
    let result: unknown;
    try {
      result = script.runInContext(this.context, { timeout: remaining });
    } catch (error) {
      // Only host-realm errors can reach here (timeouts, compile errors): user errors are
      // caught and encoded inside the context.
      this.broken = true;
      throw error;
    } finally {
      this.active = false;
    }
    return result;
  }

  // ─── host bridge ─────────────────────────────────────────────────────────

  private bridge(op: unknown, a: unknown, b: unknown): string | undefined {
    try {
      if (op === 'log' && typeof a === 'string' && typeof b === 'string') {
        this.log(a, b);
        return undefined;
      }
      if (op === 'call' && typeof a === 'number' && typeof b === 'string') {
        return this.callHost(a, b);
      }
      return JSON.stringify({ err: { n: 'Error', m: 'Invalid bridge call' } });
    } catch (error) {
      return JSON.stringify({ err: { n: 'Error', m: messageOf(error) } });
    }
  }

  private log(level: string, message: string): void {
    const lvl: SandboxLogLevel = (['log', 'info', 'warn', 'error', 'debug'] as const).includes(
      level as SandboxLogLevel,
    )
      ? (level as SandboxLogLevel)
      : 'log';
    if (this.options.onLog) {
      this.options.onLog(lvl, message);
      return;
    }
    if (lvl === 'error') this.logger.error(message);
    else if (lvl === 'warn') this.logger.warn(message);
    else if (lvl === 'debug') this.logger.debug(message);
    else this.logger.log(message);
  }

  private callHost(id: number, argsJson: string): string {
    const entry = this.hostFns[id];
    if (!entry) return JSON.stringify({ err: { n: 'Error', m: 'Unknown host function' } });
    const args = this.decodeHost(JSON.parse(argsJson), 0);
    let result: unknown;
    try {
      result = Reflect.apply(entry.fn, entry.thisArg, Array.isArray(args) ? args : []);
    } catch (error) {
      return JSON.stringify({ err: errorShape(error) });
    }
    if (isThenable(result)) {
      const promiseId = this.nextHostPromise++;
      this.outstandingHost++;
      Promise.resolve(result).then(
        (value) => this.pushSettled(promiseId, () => ({ ok: this.encodeTree(value) })),
        (error: unknown) => this.pushSettled(promiseId, () => ({ err: errorShape(error) })),
      );
      return JSON.stringify({ p: promiseId });
    }
    return JSON.stringify({ ok: this.encodeTree(result) });
  }

  private pushSettled(promiseId: number, build: () => Record<string, unknown>): void {
    this.outstandingHost--;
    let payload: Record<string, unknown>;
    try {
      payload = build();
    } catch (error) {
      payload = { err: errorShape(error) };
    }
    this.settled.push(JSON.stringify({ p: promiseId, ...payload }));
    for (const wake of [...this.waiters]) wake();
  }

  // ─── host-side encoding ──────────────────────────────────────────────────

  /** Encodes a host value into the tagged JSON format understood by the context. */
  encodeHost(value: unknown): string {
    return JSON.stringify(this.encodeTree(value));
  }

  private encodeTree(value: unknown): unknown {
    return this.encodeValue(value, 0, new Set());
  }

  private registerHostFn(fn: (...args: unknown[]) => unknown, thisArg: unknown): number {
    if (thisArg === undefined) {
      const existing = this.hostFnIds.get(fn);
      if (existing !== undefined) return existing;
    } else if (thisArg !== null && typeof thisArg === 'object') {
      const existing = this.boundHostFnIds.get(thisArg)?.get(fn);
      if (existing !== undefined) return existing;
    }
    const id = this.hostFns.length || 1;
    if (this.hostFns.length === 0) this.hostFns.push({ fn: () => undefined, thisArg: undefined });
    this.hostFns.push({ fn, thisArg });
    if (thisArg === undefined) {
      this.hostFnIds.set(fn, id);
    } else if (thisArg !== null && typeof thisArg === 'object') {
      let byFn = this.boundHostFnIds.get(thisArg);
      if (!byFn) {
        byFn = new Map();
        this.boundHostFnIds.set(thisArg, byFn);
      }
      byFn.set(fn, id);
    }
    return id;
  }

  private encodeValue(v: unknown, depth: number, seen: Set<object>): unknown {
    if (depth > MAX_DEPTH) throw new TypeError('Value is nested too deeply');
    switch (typeof v) {
      case 'string':
      case 'boolean':
        return v;
      case 'number':
        if (Number.isNaN(v)) return { $: 'n', v: 'NaN' };
        if (v === Infinity) return { $: 'n', v: 'Infinity' };
        if (v === -Infinity) return { $: 'n', v: '-Infinity' };
        if (Object.is(v, -0)) return { $: 'n', v: '-0' };
        return v;
      case 'undefined':
      case 'symbol':
        return { $: 'u' };
      case 'bigint':
        return { $: 'b', v: v.toString() };
      case 'function':
        return { $: 'f', v: this.registerHostFn(v as (...args: unknown[]) => unknown, undefined) };
      default:
        break;
    }
    if (v === null) return null;
    const obj = v as object;
    if (seen.has(obj)) throw new TypeError('Cannot transfer a circular structure into the sandbox');
    seen.add(obj);
    try {
      if (Array.isArray(obj)) return { $: 'a', v: obj.map((x) => this.encodeValue(x, depth + 1, seen)) };
      if (obj instanceof Date) {
        const ms = obj.getTime();
        return { $: 'd', v: Number.isNaN(ms) ? null : ms };
      }
      if (obj instanceof Map) {
        return {
          $: 'm',
          v: [...obj].map(([k, x]) => [this.encodeValue(k, depth + 1, seen), this.encodeValue(x, depth + 1, seen)]),
        };
      }
      if (obj instanceof Set) return { $: 's', v: [...obj].map((x) => this.encodeValue(x, depth + 1, seen)) };
      if (obj instanceof RegExp) return { $: 'r', v: obj.source, f: obj.flags };
      if (ArrayBuffer.isView(obj)) {
        return { $: 'y', v: [...new Uint8Array(obj.buffer, obj.byteOffset, obj.byteLength)] };
      }
      if (obj instanceof Error) return { $: 'e', n: obj.name, m: obj.message };
      const entries: unknown[] = [];
      const proto0 = Object.getPrototypeOf(obj) as object | null;
      const isInstance = proto0 !== null && proto0 !== Object.prototype;
      const dataOnly = isInstance && this.options.exposeMethods === false;
      for (const key of Object.keys(obj)) {
        const value = (obj as Record<string, unknown>)[key];
        if (typeof value === 'function') {
          if (dataOnly) continue;
          entries.push([key, { $: 'f', v: this.registerHostFn(value as (...args: unknown[]) => unknown, obj) }]);
        } else {
          entries.push([key, this.encodeValue(value, depth + 1, seen)]);
        }
      }
      if (dataOnly) return { $: 'o', v: entries };
      // Class instances: expose prototype methods (bound to the instance) like the old sandbox did.
      let proto = proto0;
      const ownKeys = new Set(Object.keys(obj));
      while (proto && proto !== Object.prototype) {
        for (const key of Object.getOwnPropertyNames(proto)) {
          if (key === 'constructor' || ownKeys.has(key)) continue;
          const desc = Object.getOwnPropertyDescriptor(proto, key);
          if (desc && typeof desc.value === 'function') {
            ownKeys.add(key);
            entries.push([key, { $: 'f', v: this.registerHostFn(desc.value as (...args: unknown[]) => unknown, obj) }]);
          }
        }
        proto = Object.getPrototypeOf(proto) as object | null;
      }
      return { $: 'o', v: entries };
    } finally {
      seen.delete(obj);
    }
  }

  /** Decodes the tagged JSON (already parsed by the host's JSON.parse) into host values. */
  decodeHost(node: unknown, depth: number): unknown {
    if (depth > MAX_DEPTH) throw new TypeError('Value is nested too deeply');
    if (node === null || typeof node !== 'object') {
      if (node === null || typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
        return node;
      }
      throw new TypeError('Invalid value from sandbox');
    }
    const n = node as { $?: unknown; v?: unknown; f?: unknown; n?: unknown; m?: unknown };
    const list = (): unknown[] => {
      if (!Array.isArray(n.v)) throw new TypeError('Invalid value from sandbox');
      return n.v;
    };
    switch (n.$) {
      case 'u':
        return undefined;
      case 'n':
        return n.v === 'NaN' ? NaN : n.v === 'Infinity' ? Infinity : n.v === '-Infinity' ? -Infinity : -0;
      case 'b':
        return BigInt(String(n.v));
      case 'f':
        if (typeof n.v !== 'number') throw new TypeError('Invalid value from sandbox');
        return this.makeCallable(n.v);
      case 'd':
        return new Date(typeof n.v === 'number' ? n.v : NaN);
      case 'r':
        return new RegExp(String(n.v), String(n.f ?? ''));
      case 'y':
        return Uint8Array.from(list() as number[]);
      case 'e': {
        const error = new Error(String(n.m));
        error.name = String(n.n);
        return error;
      }
      case 'a':
        return list().map((x) => this.decodeHost(x, depth + 1));
      case 's':
        return new Set(list().map((x) => this.decodeHost(x, depth + 1)));
      case 'm':
        return new Map(
          list().map((pair) => {
            if (!Array.isArray(pair) || pair.length !== 2) throw new TypeError('Invalid value from sandbox');
            return [this.decodeHost(pair[0], depth + 1), this.decodeHost(pair[1], depth + 1)] as const;
          }),
        );
      case 'o': {
        const out: Record<string, unknown> = {};
        for (const pair of list()) {
          if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string') {
            throw new TypeError('Invalid value from sandbox');
          }
          Object.defineProperty(out, pair[0], {
            value: this.decodeHost(pair[1], depth + 1),
            writable: true,
            enumerable: true,
            configurable: true,
          });
        }
        return out;
      }
      default:
        throw new TypeError('Invalid value from sandbox');
    }
  }

  /** A host function that runs a sandbox function under the sandbox timeout. */
  private makeCallable(id: number): (...args: unknown[]) => unknown {
    return (...args: unknown[]) => {
      const deadline = Date.now() + this.options.timeout;
      const reply = this.invoke(id, args, deadline);
      return settleSync(this, reply, deadline, true);
    };
  }

  toHostError(err: { n?: unknown; m?: unknown } | undefined): Error {
    const error = new Error(typeof err?.m === 'string' ? err.m : 'Script error');
    if (typeof err?.n === 'string' && err.n) error.name = err.n;
    return error;
  }
}

/**
 * Settles a reply. Returns the value when it is available synchronously. When it depends on
 * host promises, returns a Promise if `allowAsync`, otherwise throws.
 */
function settleSync(realm: SandboxRealm, reply: string, deadline: number, allowAsync: boolean): unknown {
  const first = realm.readReply(reply);
  if (first.done) return first.value;
  const slot = first.slot;
  const polled = realm.pollSlot(slot, deadline);
  if (polled !== undefined) {
    const r = realm.readReply(polled);
    if (r.done) return r.value;
  }
  if (!realm.hasOutstandingHostWork()) {
    throw new Error('Script returned a promise that never settles');
  }
  if (!allowAsync) {
    throw new Error(
      'Script result depends on an asynchronous host function; use executeAsync()',
    );
  }
  return settleAsync(realm, slot, deadline);
}

async function settleAsync(realm: SandboxRealm, slot: number, deadline: number): Promise<unknown> {
  for (;;) {
    if (!realm.deliverSettled(deadline)) {
      if (!realm.hasOutstandingHostWork()) {
        throw new Error('Script returned a promise that never settles');
      }
      await realm.waitForHost(deadline);
      continue;
    }
    const polled = realm.pollSlot(slot, deadline);
    if (polled !== undefined) {
      const r = realm.readReply(polled);
      if (r.done) return r.value;
    }
    if (Date.now() >= deadline) throw realm.timeoutError();
  }
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    v !== null &&
    (typeof v === 'object' || typeof v === 'function') &&
    typeof (v as { then?: unknown }).then === 'function'
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorShape(error: unknown): { n: string; m: string } {
  if (error instanceof Error) return { n: error.name, m: error.message };
  return { n: 'Error', m: String(error) };
}

// ─── unhandled rejections from sandbox realms ─────────────────────────────

/**
 * Shared with `@zucker-framework/core`'s `evaluate()` (which installs an identical guard) so that
 * at most one listener is registered per process, whichever package installs it first.
 */
const REJECTION_GUARD_KEY = Symbol.for('zucker-framework.sandbox-rejection-guard');
const MAX_REASON_LENGTH = 200;

/**
 * Installs (once per process) an `unhandledRejection` listener that keeps a rejected promise
 * created inside a vm context from terminating the process.
 *
 * V8 reports unhandled rejections isolate-wide and Node's default mode turns them into an
 * uncaught exception, so `Promise.reject(1)` in a sandbox script or rule expression would
 * otherwise kill the host. A promise is treated as sandbox-owned when the host
 * `Promise.prototype` is not on its prototype chain: sandbox code cannot reach the host
 * intrinsic, so it cannot make its promises look like host promises. This also covers any other
 * `vm` context in the process. Sandbox-owned rejections are logged (the reason is not inspected
 * beyond `typeof`, because reading its properties could run sandbox code outside any timeout).
 *
 * Host promises keep Node's semantics: when no other `unhandledRejection` listener is
 * registered, the listener re-raises the reason as an uncaught exception (default `throw`
 * mode) or warns and sets `process.exitCode` (`warn-with-error-code` mode). When the application
 * registered its own listener, that listener decides.
 *
 * Called automatically by `createSandbox()`; exported so applications and tests can install it
 * eagerly.
 */
export function installSandboxRejectionGuard(): void {
  const registry = globalThis as Record<symbol, unknown>;
  if (registry[REJECTION_GUARD_KEY]) return;
  const logger = new Logger('Sandbox');
  const listener = (reason: unknown, promise: unknown): void => {
    if (!(promise instanceof Promise)) {
      const type = reason === null ? 'null' : typeof reason;
      const detail =
        typeof reason === 'string' || typeof reason === 'number' || typeof reason === 'boolean'
          ? `: ${String(reason).slice(0, MAX_REASON_LENGTH)}`
          : ` (reason type: ${type})`;
      logger.warn(`Unhandled promise rejection inside a sandbox ignored${detail}`);
      return;
    }
    if (process.listenerCount('unhandledRejection') > 1) return;
    const mode = unhandledRejectionsMode();
    if (mode === 'throw') {
      throw reason instanceof Error ? reason : unhandledRejectionError(reason);
    }
    if (mode === 'warn-with-error-code') {
      process.emitWarning(unhandledRejectionError(reason).message, 'UnhandledPromiseRejectionWarning');
      process.exitCode = 1;
    }
    // 'warn' / 'strict' / 'none': Node already applied the mode's behaviour.
  };
  registry[REJECTION_GUARD_KEY] = listener;
  process.on('unhandledRejection', listener);
}

function unhandledRejectionsMode(): string {
  const flags = [...process.execArgv, ...(process.env.NODE_OPTIONS ?? '').split(/\s+/)];
  let mode = 'throw';
  for (const flag of flags) {
    const m = /^--unhandled-rejections=(.+)$/.exec(flag);
    if (m) mode = m[1];
  }
  return mode;
}

function unhandledRejectionError(reason: unknown): Error {
  let text: string;
  try {
    text = String(reason);
  } catch {
    text = typeof reason;
  }
  const error = new Error(
    'This error originated either by throwing inside of an async function without a catch block, ' +
      `or by rejecting a promise which was not handled with .catch(). The promise rejected with the reason "${text}".`,
  ) as Error & { code?: string };
  error.name = 'UnhandledPromiseRejection';
  error.code = 'ERR_UNHANDLED_REJECTION';
  return error;
}

export function createSandbox(options: SandboxOptions): AsyncSandbox {
  installSandboxRejectionGuard();
  const logger = new Logger(options.name ? `Sandbox:${options.name}` : 'Sandbox');
  const run = (code: string, context: Record<string, unknown>, allowAsync: boolean): unknown => {
    const deadline = Date.now() + options.timeout;
    const realm = new SandboxRealm(options, logger);
    const reply = realm.runMain(code, context, deadline);
    return settleSync(realm, reply, deadline, allowAsync);
  };
  return {
    execute(code: string, context: Record<string, unknown> = {}): unknown {
      return run(code, context, false);
    },
    async executeAsync(code: string, context: Record<string, unknown> = {}): Promise<unknown> {
      return run(code, context, true);
    },
  };
}
