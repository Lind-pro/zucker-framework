export interface Term {
  column: string;
  termType: string;
  value: unknown;
  /** 嵌套条件组（对齐 jetlinks Term 嵌套） */
  terms?: Term[];
  /** 嵌套组的连接类型 */
  termsType?: 'and' | 'or';
}

export interface TermCondition {
  terms: Term[];
  type: 'and' | 'or';
}

const OPERATORS: Record<
  string,
  (fieldValue: unknown, termValue: unknown) => boolean
> = {
  eq: (a, b) => a === b,
  neq: (a, b) => a !== b,
  gt: (a, b) => Number(a) > Number(b),
  gte: (a, b) => Number(a) >= Number(b),
  lt: (a, b) => Number(a) < Number(b),
  lte: (a, b) => Number(a) <= Number(b),
  like: (a, b) =>
    typeof a === 'string' && typeof b === 'string' && a.includes(b),
  nlike: (a, b) =>
    typeof a === 'string' && typeof b === 'string' && !a.includes(b),
  in: (a, b) => Array.isArray(b) && b.includes(a),
  nin: (a, b) => Array.isArray(b) && !b.includes(a),
  isnull: (a) => a === null || a === undefined,
  notnull: (a) => a !== null && a !== undefined,
  between: (a, b) => {
    if (!Array.isArray(b) || b.length !== 2) return false;
    const v = Number(a);
    return v >= Number(b[0]) && v <= Number(b[1]);
  },
  // 新增操作符 — 对齐 jetlinks TermType 扩展
  empty: (a) =>
    a === null ||
    a === undefined ||
    a === '' ||
    (Array.isArray(a) && a.length === 0),
  nempty: (a) =>
    a !== null &&
    a !== undefined &&
    a !== '' &&
    !(Array.isArray(a) && a.length === 0),
  starts_with: (a, b) =>
    typeof a === 'string' && typeof b === 'string' && a.startsWith(b),
  ends_with: (a, b) =>
    typeof a === 'string' && typeof b === 'string' && a.endsWith(b),
  contains_all: (a, b) =>
    Array.isArray(a) && Array.isArray(b) && b.every((item) => a.includes(item)),
  contains_any: (a, b) =>
    Array.isArray(a) && Array.isArray(b) && b.some((item) => a.includes(item)),
};

export class TermsEvaluator {
  /**
   * 注册自定义操作符 — 对齐 jetlinks 可扩展的 TermType
   */
  registerOperator(
    name: string,
    fn: (fieldValue: unknown, termValue: unknown) => boolean,
  ): void {
    OPERATORS[name] = fn;
  }

  /**
   * 获取已注册的所有操作符名称
   */
  getOperatorNames(): string[] {
    return Object.keys(OPERATORS);
  }

  evaluate(data: Record<string, unknown>, condition: TermCondition): boolean {
    return this.evaluateTerms(data, condition.terms, condition.type);
  }

  private evaluateTerms(
    data: Record<string, unknown>,
    terms: Term[],
    type: 'and' | 'or',
  ): boolean {
    const results = terms.map((term) => {
      // 处理嵌套条件组
      if (term.terms && term.terms.length > 0) {
        return this.evaluateTerms(
          data,
          term.terms,
          term.termsType ?? 'and',
        );
      }

      const fieldValue = getNestedValue(data, term.column);
      const operator = OPERATORS[term.termType];
      if (!operator) {
        throw new Error(`Unknown term type: ${term.termType}`);
      }
      return operator(fieldValue, term.value);
    });

    return type === 'and' ? results.every(Boolean) : results.some(Boolean);
  }
}

/**
 * 获取嵌套属性值 — 支持点分路径如 "device.properties.temperature"
 * 对齐 jetlinks TermColumn 的嵌套属性访问
 */
function getNestedValue(
  data: Record<string, unknown>,
  path: string,
): unknown {
  if (!path.includes('.')) {
    return data[path];
  }

  const parts = path.split('.');
  let current: unknown = data;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
