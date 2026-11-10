/**
 * ExpressionUtils — 表达式求值
 */

import * as vm from 'node:vm';

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
 * JS 表达式求值
 * @param expression - JS 表达式字符串
 * @param context - 上下文变量（按数据复制进沙箱；函数不会被传入）
 *
 * SECURITY: expressions must be developer-authored. `node:vm` is not a security boundary;
 * this function only limits accidental damage (keyword blacklist, a fresh realm whose
 * intrinsics are not host objects, data-only context, a synchronous + microtask timeout).
 * Never pass end-user supplied text here; use a dedicated expression language for that.
 */
export function evaluate(expression: string, context: Record<string, unknown> = {}): unknown {
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
  const readJson = vm.runInContext(SANDBOX_JSON_READER, vmContext) as (json: string) => unknown;
  for (const [k, v] of Object.entries(context)) {
    if (!/^[A-Za-z_$][\w$]*$/.test(k)) continue;
    const copied = toSandboxValue(v, readJson);
    if (copied !== undefined) (vmContext as Record<string, unknown>)[k] = copied;
  }

  try {
    return vm.runInContext(`"use strict"; (${expression});`, vmContext, {
      timeout: EXECUTION_TIMEOUT_MS,
      filename: 'expression',
    });
  } catch (e) {
    throw new Error(
      `Failed to evaluate expression: ${expression} — ${e instanceof Error ? e.message : String(e)}`,
    );
  }
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
      const result = evaluate(trimmed, context);
      return result === undefined || result === null ? '' : String(result);
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
