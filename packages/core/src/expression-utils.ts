/**
 * ExpressionUtils — 表达式求值
 * 参考: hsweb-framework ExpressionUtils.java
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

/** 沙箱白名单：只暴露安全的内置函数 */
const SANDBOX_GLOBALS = Object.freeze({
  Math,
  Date,
  JSON: Object.freeze({ parse: JSON.parse, stringify: JSON.stringify }),
  Number,
  String,
  Boolean,
  Array,
  parseInt,
  parseFloat,
  isNaN,
  isFinite,
  undefined,
  NaN,
  Infinity,
});

/**
 * JS 表达式求值
 * @param expression - JS 表达式字符串
 * @param context - 上下文变量
 *
 * 对比 hsweb ExpressionUtils:
 * - hsweb 支持多语言引擎 (spel, groovy, js)，zucker 仅支持 JS（TypeScript 生态足够）
 * - 增加表达式长度限制防止滥用
 * - 使用 vm.runInNewContext() 沙箱执行，防止 RCE
 */
export function evaluate(expression: string, context: Record<string, unknown> = {}): unknown {
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    throw new Error(`Expression too long (${expression.length} > ${MAX_EXPRESSION_LENGTH})`);
  }

  // Block dangerous patterns
  if (DANGEROUS_PATTERNS.test(expression)) {
    throw new Error(`Expression contains blocked keyword: ${expression}`);
  }

  // Build frozen sandbox with whitelisted globals + user context
  const sandbox: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(SANDBOX_GLOBALS)) {
    sandbox[k] = v;
  }
  for (const [k, v] of Object.entries(context)) {
    sandbox[k] = v;
  }
  Object.freeze(sandbox);

  try {
    return vm.runInNewContext(`"use strict"; (${expression});`, sandbox, {
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
 * 对比 hsweb ExpressionUtils.analytical / TemplateParser:
 * - hsweb 先尝试从 vars 中直接查找变量名，找到就用；找不到才调引擎求值
 * - zucker 增加同样的快速路径优化
 */
export function evaluateTemplate(template: string, context: Record<string, unknown> = {}): string {
  if (!template.includes('${')) return template;

  return template.replace(TEMPLATE_PATTERN, (_match, expr: string) => {
    const trimmed = expr.trim();
    try {
      // 快速路径：如果表达式是简单变量名，直接从 context 取值
      // 参考 hsweb: Object val = vars.get(var); if (val != null) return String.valueOf(val);
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
 * 参考 hsweb TemplateParser 中的 BeanUtilsBean.getProperty(parameter, var)
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
