/**
 * ExpressionUtils — 表达式求值
 */

import * as vm from 'node:vm';
import { randomBytes } from 'node:crypto';

const TEMPLATE_PATTERN = /\$\{(.+?)\}/g;

/** 表达式最大长度限制，防止注入超长代码 */
const MAX_EXPRESSION_LENGTH = 4096;

/** 沙箱执行超时（毫秒），防止死循环 */
const EXECUTION_TIMEOUT_MS = 100;

/**
 * Patterns that indicate potentially dangerous code in expressions.
 * Blocks access to process, require, import, eval, Function constructor,
 * globalThis, global, this, Reflect, Proxy, Object, etc.
 */
const DANGEROUS_PATTERNS = /\b(process|require|import|eval|Function|constructor|__proto__|prototype|globalThis|global|this|Reflect|Proxy)\b|`/;

/**
 * Copies a caller value into the sandbox realm.
 *
 * Host-realm objects must never be reachable from the expression: every host object's
 * prototype chain leads to the host `Function` constructor (`x.constructor.constructor`),
 * which compiles code with access to `process`. Values are therefore re-created inside the
 * sandbox from JSON (Dates are preserved). Functions, symbols and other non-data values are
 * not copied.
 */
function toSandboxValue(value: unknown, sandboxFromJson: (json: string) => unknown): unknown {
  if (value === null || value === undefined) return value;
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return value;
  if (type === 'bigint') return Number(value);
  if (type !== 'object') return undefined;
  const json = JSON.stringify(value, function replacer(this: unknown, key: string, jsonValue: unknown) {
    // `jsonValue` has already been through Date#toJSON; read the raw holder value instead.
    const raw = key === '' ? value : (this as Record<string, unknown>)[key];
    if (raw instanceof Date) return { [DATE_TAG]: raw.getTime() };
    if (typeof jsonValue === 'bigint') return Number(jsonValue);
    return jsonValue;
  });
  return json === undefined ? undefined : sandboxFromJson(json);
}

const DATE_TAG = '__zuckerExpressionDate';

/** Runs inside the sandbox realm, so the parsed objects use the sandbox's own intrinsics. */
const SANDBOX_JSON_READER = `(function (json) {
  return JSON.parse(json, function (key, value) {
    if (value && typeof value === 'object' && Object.keys(value).length === 1 && typeof value['${DATE_TAG}'] === 'number') {
      return new Date(value['${DATE_TAG}']);
    }
    return value;
  });
})`;

/**
 * Runs inside the sandbox realm before the expression, capturing the intrinsics it needs so the
 * expression cannot redirect them. Returns the output function that evaluates the expression
 * (passed as a thunk) and converts its result, all inside the same `runInContext` call and
 * therefore the same timeout. The host only ever receives primitives:
 *
 * - an error thrown by the expression: `e` + message;
 * - `mode === 'string'` (templates): `s` + (`''` for null/undefined, otherwise `String(value)`);
 * - `mode === 'value'`: non-string primitives as is (they carry no realm); strings as `s` + value;
 *   objects as `j` + JSON (Dates tagged). Functions and symbols become `undefined`; promises and
 *   other thenables are rejected.
 */
const SANDBOX_RESULT_WRITER = `(function () {
  'use strict';
  const stringify = JSON.stringify;
  const StringC = String;
  const ErrorC = Error;
  const apply = Reflect.apply;
  const getTime = Date.prototype.getTime;
  function isDate(v) { try { apply(getTime, v, []); return true; } catch (e) { return false; } }
  function message(e) {
    try {
      if (e !== null && (typeof e === 'object' || typeof e === 'function')) {
        const m = e.message;
        return typeof m === 'string' ? m : StringC(e);
      }
      return StringC(e);
    } catch (x) {
      return 'Expression error';
    }
  }
  function convert(mode, v) {
    const t = typeof v;
    if (mode === 'string') return 's' + (v === null || v === undefined ? '' : StringC(v));
    if (t === 'string') return 's' + v;
    if (t === 'function' || t === 'symbol') return undefined;
    if (v === null || t !== 'object') return v;
    if (typeof v.then === 'function') {
      throw new ErrorC('Expression results must be plain data, not a promise or thenable');
    }
    const json = stringify(v, function (key, value) {
      const raw = key === '' ? v : this[key];
      if (raw !== null && typeof raw === 'object' && isDate(raw)) {
        const ms = apply(getTime, raw, []);
        return { '${DATE_TAG}': ms === ms ? ms : null };
      }
      if (typeof value === 'bigint') return Number(value);
      return value;
    });
    return json === undefined ? undefined : 'j' + json;
  }
  return function (mode, thunk) {
    try { return convert(mode, thunk()); } catch (e) { return 'e' + message(e); }
  };
})()`;

/** Host-side reader for the writer's `j` payload: plain host objects, tagged Dates revived. */
function fromResultJson(json: string): unknown {
  return JSON.parse(json, (_key, value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length === 1 && keys[0] === DATE_TAG) {
        const ms = (value as Record<string, unknown>)[DATE_TAG];
        return new Date(typeof ms === 'number' ? ms : NaN);
      }
    }
    return value;
  });
}

type ResultMode = 'value' | 'string';

/**
 * JS 表达式求值
 * @param expression - JS 表达式字符串
 * @param context - 上下文变量（按数据复制进沙箱；函数不会被传入）
 * @returns 结果按数据复制回宿主：基本类型原样返回；对象/数组以 JSON 复制（Date 保留），
 *   函数与 symbol 变为 `undefined`；Promise / thenable 结果会抛错。
 *
 * SECURITY: expressions must be developer-authored. `node:vm` is not a security boundary;
 * this function only limits accidental damage (keyword blacklist, a fresh realm whose
 * intrinsics are not host objects, data-only context and result, a synchronous + microtask
 * timeout that also covers copying the result out).
 * Never pass end-user supplied text here; use a dedicated expression language for that.
 */
export function evaluate(expression: string, context: Record<string, unknown> = {}): unknown {
  return run(expression, context, 'value');
}

function run(expression: string, context: Record<string, unknown>, mode: ResultMode): unknown {
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    throw new Error(`Expression too long (${expression.length} > ${MAX_EXPRESSION_LENGTH})`);
  }

  // Block dangerous patterns
  if (DANGEROUS_PATTERNS.test(expression)) {
    throw new Error(`Expression contains blocked keyword: ${expression}`);
  }

  // A fresh context exposes its own Math/Date/JSON/Number/String/Array... intrinsics; none of
  // them are host-realm objects, so their constructor chain ends at the sandbox Function.
  const vmContext = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: 'afterEvaluate',
  });
  installSandboxRejectionGuard();
  const readJson = vm.runInContext(SANDBOX_JSON_READER, vmContext) as (json: string) => unknown;
  // Random, non-writable binding: the expression runs after this and cannot replace the writer.
  const writerName = `__zkOut_${randomBytes(6).toString('hex')}`;
  Object.defineProperty(vmContext, writerName, {
    value: vm.runInContext(SANDBOX_RESULT_WRITER, vmContext),
    writable: false,
    configurable: false,
    enumerable: false,
  });
  for (const [k, v] of Object.entries(context)) {
    if (!/^[A-Za-z_$][\w$]*$/.test(k)) continue;
    const copied = toSandboxValue(v, readJson);
    if (copied !== undefined) (vmContext as Record<string, unknown>)[k] = copied;
  }

  let raw: unknown;
  try {
    // The result is copied out inside the same call, so getters, toJSON/toString overrides and
    // thenable checks all run under the timeout; the host only receives primitives.
    raw = vm.runInContext(
      `"use strict"; ${writerName}(${JSON.stringify(mode)}, () => (${expression}\n));`,
      vmContext,
      { timeout: EXECUTION_TIMEOUT_MS, filename: 'expression' },
    );
  } catch (e) {
    throw new Error(
      `Failed to evaluate expression: ${expression} — ${errorMessage(e)}`,
    );
  }
  if (typeof raw === 'string') {
    if (raw.startsWith('e')) throw new Error(`Failed to evaluate expression: ${expression} — ${raw.slice(1)}`);
    if (raw.startsWith('s')) return raw.slice(1);
    if (raw.startsWith('j')) return fromResultJson(raw.slice(1));
    throw new Error(`Failed to evaluate expression: ${expression} — invalid result`);
  }
  // Non-string primitives only: anything else could carry sandbox code back to the host.
  if (raw !== null && (typeof raw === 'object' || typeof raw === 'function')) {
    throw new Error(`Failed to evaluate expression: ${expression} — invalid result`);
  }
  return raw;
}

/**
 * Message of an error thrown by `runInContext`. Errors thrown by the expression are sandbox-realm
 * objects; reading their properties could run sandbox code (getters) outside the timeout, so only
 * host-realm errors (timeouts, syntax errors) are inspected.
 */
function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e === null || (typeof e !== 'object' && typeof e !== 'function')) return String(e);
  return 'expression threw a non-host error';
}

// ─── unhandled rejections from sandbox realms ─────────────────────────────

/**
 * Same registry key as `installSandboxRejectionGuard()` in `@zucker-framework/script`, so the
 * process gets exactly one listener whichever package installs it first.
 */
const REJECTION_GUARD_KEY = Symbol.for('zucker-framework.sandbox-rejection-guard');

/**
 * Keeps a rejected promise created inside an expression realm (e.g.
 * `(async () => { throw 1 })() && 1`) from terminating the process: V8 reports unhandled
 * rejections isolate-wide. Promises whose prototype chain does not contain the host
 * `Promise.prototype` are sandbox-owned (sandbox code cannot reach the host intrinsic); they are
 * reported with `process.emitWarning` without reading the reason's properties. Host promises keep
 * Node's semantics when no other listener is registered.
 */
function installSandboxRejectionGuard(): void {
  const registry = globalThis as Record<symbol, unknown>;
  if (registry[REJECTION_GUARD_KEY]) return;
  const listener = (reason: unknown, promise: unknown): void => {
    if (!(promise instanceof Promise)) {
      const detail =
        typeof reason === 'string' || typeof reason === 'number' || typeof reason === 'boolean'
          ? `: ${String(reason).slice(0, 200)}`
          : ` (reason type: ${reason === null ? 'null' : typeof reason})`;
      process.emitWarning(`Unhandled promise rejection inside a sandbox ignored${detail}`, 'SandboxWarning');
      return;
    }
    if (process.listenerCount('unhandledRejection') > 1) return;
    const mode = unhandledRejectionsMode();
    if (mode === 'throw') throw reason instanceof Error ? reason : unhandledRejectionError(reason);
    if (mode === 'warn-with-error-code') {
      process.emitWarning(unhandledRejectionError(reason).message, 'UnhandledPromiseRejectionWarning');
      process.exitCode = 1;
    }
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

/**
 * 模板求值 — 替换 `${expr}` 占位符
 * @param template - 包含 `${expr}` 占位符的模板字符串
 * @param context - 上下文变量
 *
 * 先尝试按变量路径从 context 取值，未找到时再进行表达式求值。
 */
export function evaluateTemplate(template: string, context: Record<string, unknown> = {}): string {
  if (!template.includes('${')) return template;

  return template.replace(TEMPLATE_PATTERN, (_match, expr: string) => {
    const trimmed = expr.trim();
    try {
      // 快速路径：如果表达式是简单变量名，直接从 context 取值
      if (/^[\w.]+$/.test(trimmed)) {
        const directValue = getNestedValue(context, trimmed);
        if (directValue !== undefined) {
          return directValue === null ? '' : String(directValue);
        }
      }
      // Converted to a string inside the sandbox, under the timeout (a `toString` override
      // must not run on the host).
      return run(trimmed, context, 'string') as string;
    } catch {
      return '';
    }
  });
}

/**
 * 嵌套属性访问 — 支持 "a.b.c" 路径
 * 支持通过点分隔的路径读取嵌套属性。
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * 清除表达式缓存（vm.runInNewContext 无缓存，保留接口兼容）
 */
export function clearExpressionCache(): void {
  // no-op: vm.runInNewContext does not use a cache
}
