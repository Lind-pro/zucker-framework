import { type Term } from '@zucker/core';

/**
 * 将 WHERE 表达式解析为 Term[]
 * 支持: =, !=, >, <, >=, <=, like, not-like, in, not-in, is-null, is-not-null
 * 支持: and, or 连接
 * 支持: 字符串值用单引号包裹
 *
 * 例: "name = '张三' and age > 16"
 */
export function parseExpression(expression: string): Term[] {
  const terms: Term[] = [];
  const tokens = tokenize(expression);
  let i = 0;
  let currentType: 'and' | 'or' = 'and';

  while (i < tokens.length) {
    const column = tokens[i++];
    if (!column) break;

    // 检查是否是 and/or 连接词
    const lower = column.toLowerCase();
    if (lower === 'and' || lower === 'or') {
      currentType = lower;
      continue;
    }

    const operatorToken = tokens[i++];
    if (!operatorToken) break;

    const termType = convertOperator(operatorToken);

    // is-null / is-not-null 不需要值
    if (termType === 'is-null' || termType === 'is-not-null') {
      terms.push({ column, termType, value: termType === 'is-null', type: currentType });
      currentType = 'and';
      continue;
    }

    const valueToken = tokens[i++];
    if (valueToken === undefined) break;

    let value: unknown = valueToken;

    // in / not-in 值可能是括号包裹的列表: (a,b,c)
    if ((termType === 'in' || termType === 'not-in') && typeof value === 'string') {
      value = parseListValue(value);
    }

    terms.push({ column, termType, value, type: currentType });
    currentType = 'and';
  }

  return terms;
}

/**
 * 将 {"field$operator": value} 格式解析为 Term[]
 * 如 {"name$like": "张"} -> [{column: "name", termType: "like", value: "张"}]
 * 没有 $ 的 key 默认 eq 操作符
 * $or$ 前缀表示 or 连接
 * $nest / $orNest 前缀表示嵌套条件
 */
export function parseFilterMap(filterMap: Record<string, unknown>): Term[] {
  const terms: Term[] = [];

  for (const [key, value] of Object.entries(filterMap)) {
    if (value === undefined || value === null) continue;

    let isOr = false;
    let processedKey = key;

    // 嵌套条件
    if (processedKey.startsWith('$nest') || (isOr = processedKey.startsWith('$orNest'))) {
      const nested = typeof value === 'object' && !Array.isArray(value)
        ? parseFilterMap(value as Record<string, unknown>)
        : [];
      const term: Term = {
        column: '',
        termType: 'nest',
        value: null,
        type: isOr ? 'or' : 'and',
        terms: nested,
      };
      terms.push(term);
      continue;
    }

    // $or$ 前缀
    if (processedKey.startsWith('$or$')) {
      isOr = true;
      processedKey = processedKey.substring(4);
    }

    const dollarIndex = processedKey.indexOf('$');
    let column: string;
    let termType: string;

    if (dollarIndex === -1) {
      column = processedKey;
      termType = 'eq';
    } else {
      column = processedKey.substring(0, dollarIndex);
      termType = processedKey.substring(dollarIndex + 1);
    }

    terms.push({
      column,
      termType,
      value,
      type: isOr ? 'or' : 'and',
    });
  }

  return terms;
}

function tokenize(expression: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';

  for (const ch of expression) {
    if (inQuote) {
      if (ch === quoteChar) {
        inQuote = false;
        tokens.push(current);
        current = '';
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '\'' || ch === '"') {
      if (current) {
        tokens.push(current);
        current = '';
      }
      inQuote = true;
      quoteChar = ch;
      continue;
    }

    if (ch === ' ' || ch === '\t') {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (current) tokens.push(current);
  return tokens;
}

function convertOperator(op: string): string {
  switch (op) {
    case '=': return 'eq';
    case '!=': return 'neq';
    case '>': return 'gt';
    case '<': return 'lt';
    case '>=': return 'gte';
    case '<=': return 'lte';
    default: return op.toLowerCase();
  }
}

function parseListValue(value: string): string[] {
  let v = value.trim();
  if (v.startsWith('(') && v.endsWith(')')) {
    v = v.substring(1, v.length - 1);
  }
  return v.split(',').map((s) => s.trim());
}
