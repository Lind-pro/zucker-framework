import { type Term } from '@zucker/core';

/**
 * 完整的 SQL-like 表达式解析器
 * 支持运算符：=, !=, >, >=, <, <=, like, in, not in, between, is null, is not null
 * 支持 AND/OR 组合和括号嵌套
 *
 * 示例: "name = '张三' and (age > 16 or status in ('active', 'pending'))"
 */
export class TermExpressionParser {
  private tokens: Token[] = [];
  private pos = 0;

  /**
   * 解析排序表达式
   * 对齐 hsweb TermExpressionParser.parseOrder()
   * 例: "age asc,score desc"
   * @returns 排序数组 [{name: 'age', order: 'asc'}, {name: 'score', order: 'desc'}]
   */
  static parseOrder(expression: string): Array<{ name: string; order: 'asc' | 'desc' }> {
    if (!expression || expression.trim().length === 0) return [];
    return expression.split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => {
        const parts = s.split(/\s+/);
        const name = parts[0];
        const order: 'asc' | 'desc' = parts.length > 1 && parts[1].toLowerCase() === 'desc' ? 'desc' : 'asc';
        return { name, order };
      });
  }

  /**
   * 解析 Map 为 Term[]
   * 对齐 hsweb TermExpressionParser.parse(Map)
   *
   * 格式:
   * - {"name$like": "张三"} -> column=name, termType=like, value=张三
   * - {"$or$status$in": [1,2,3]} -> or 连接, column=status, termType=in
   * - {"$nest": {"age$gt": 10}} -> 嵌套条件
   * - {"$orNest": {"age$gt": 10}} -> or 嵌套条件
   */
  static parseMap(map: Record<string, unknown>): Term[] {
    if (!map || Object.keys(map).length === 0) return [];

    const terms: Term[] = [];

    for (const [rawKey, value] of Object.entries(map)) {
      if (value === undefined) continue;

      let key = rawKey;
      let isOr = false;

      // 嵌套条件
      if (key.startsWith('$nest') || (isOr = key.startsWith('$orNest'))) {
        const nested = typeof value === 'object' && value !== null && !Array.isArray(value)
          ? TermExpressionParser.parseMap(value as Record<string, unknown>)
          : typeof value === 'string'
            ? new TermExpressionParser().parse(value)
            : [];
        terms.push({
          column: '',
          termType: 'nest',
          value: null,
          type: isOr ? 'or' : 'and',
          terms: nested,
        });
        continue;
      }

      // $or$ 前缀
      if (key.startsWith('$or$')) {
        isOr = true;
        key = key.substring(4);
      }

      // 分离 column 和 termType (column$termType)
      const dollarIndex = key.indexOf('$');
      let column: string;
      let termType: string;

      if (dollarIndex === -1) {
        column = key;
        termType = 'eq';
      } else {
        column = key.substring(0, dollarIndex);
        termType = key.substring(dollarIndex + 1);
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

  /**
   * 解析 SQL-like 表达式为 Term[]
   */
  parse(expression: string): Term[] {
    this.tokens = this.tokenize(expression);
    this.pos = 0;
    return this.parseOrExpression();
  }

  /** 解析 OR 层级 */
  private parseOrExpression(): Term[] {
    const terms = this.parseAndExpression();

    while (this.matchKeyword('or')) {
      const right = this.parseAndExpression();
      // 将右侧条件标记为 or
      if (right.length > 0) {
        right[0].type = 'or';
      }
      terms.push(...right);
    }

    return terms;
  }

  /** 解析 AND 层级 */
  private parseAndExpression(): Term[] {
    const terms = this.parsePrimary();

    while (this.matchKeyword('and')) {
      const right = this.parsePrimary();
      if (right.length > 0) {
        right[0].type = 'and';
      }
      terms.push(...right);
    }

    return terms;
  }

  /** 解析基本表达式：括号分组或单个条件 */
  private parsePrimary(): Term[] {
    // 括号嵌套
    if (this.match('LPAREN')) {
      const nested = this.parseOrExpression();
      this.expect('RPAREN');
      return [{
        column: '',
        termType: 'nest',
        value: null,
        type: 'and',
        terms: nested,
      }];
    }

    // 单个条件
    return [this.parseCondition()];
  }

  /** 解析单个条件表达式 */
  private parseCondition(): Term {
    const column = this.expectValue('IDENT');

    // is null / is not null
    if (this.matchKeyword('is')) {
      if (this.matchKeyword('not')) {
        this.expectKeyword('null');
        return { column, termType: 'is-not-null', value: true, type: 'and' };
      }
      this.expectKeyword('null');
      return { column, termType: 'is-null', value: true, type: 'and' };
    }

    // not in
    if (this.matchKeyword('not')) {
      if (this.matchKeyword('in')) {
        const values = this.parseValueList();
        return { column, termType: 'not-in', value: values, type: 'and' };
      }
      // not like
      if (this.matchKeyword('like')) {
        const value = this.expectValue('STRING', 'NUMBER', 'IDENT');
        return { column, termType: 'not-like', value, type: 'and' };
      }
      throw this.error('Expected "in" or "like" after "not"');
    }

    // in
    if (this.matchKeyword('in')) {
      const values = this.parseValueList();
      return { column, termType: 'in', value: values, type: 'and' };
    }

    // like
    if (this.matchKeyword('like')) {
      const value = this.expectValue('STRING', 'NUMBER', 'IDENT');
      return { column, termType: 'like', value, type: 'and' };
    }

    // between
    if (this.matchKeyword('between')) {
      const low = this.parseScalarValue();
      this.expectKeyword('and');
      const high = this.parseScalarValue();
      return { column, termType: 'between', value: [low, high], type: 'and' };
    }

    // 比较运算符: =, !=, >, >=, <, <=
    const opToken = this.expectToken('OP');
    const op = this.convertOperator(opToken.value);
    const value = this.parseScalarValue();

    return { column, termType: op, value, type: 'and' };
  }

  /** 解析括号包裹的值列表: ('a', 'b', 'c') */
  private parseValueList(): unknown[] {
    this.expect('LPAREN');
    const values: unknown[] = [];
    values.push(this.parseScalarValue());

    while (this.match('COMMA')) {
      values.push(this.parseScalarValue());
    }

    this.expect('RPAREN');
    return values;
  }

  /** 解析单个标量值 */
  private parseScalarValue(): unknown {
    const token = this.nextToken();
    if (!token) throw this.error('Expected value');

    if (token.type === 'STRING') return token.value;
    if (token.type === 'NUMBER') return Number(token.value);
    if (token.type === 'IDENT') {
      const lower = token.value.toLowerCase();
      if (lower === 'null') return null;
      if (lower === 'true') return true;
      if (lower === 'false') return false;
      return token.value;
    }

    throw this.error(`Unexpected token: ${token.type} "${token.value}"`);
  }

  // ===================== 辅助方法 =====================

  private matchKeyword(keyword: string): boolean {
    const token = this.peek();
    if (token && token.type === 'IDENT' && token.value.toLowerCase() === keyword) {
      this.pos++;
      return true;
    }
    return false;
  }

  private expectKeyword(keyword: string): void {
    if (!this.matchKeyword(keyword)) {
      throw this.error(`Expected keyword "${keyword}"`);
    }
  }

  private match(type: TokenType): boolean {
    const token = this.peek();
    if (token && token.type === type) {
      this.pos++;
      return true;
    }
    return false;
  }

  private expect(type: TokenType): Token {
    const token = this.nextToken();
    if (!token || token.type !== type) {
      throw this.error(`Expected ${type}, got ${token?.type ?? 'EOF'}`);
    }
    return token;
  }

  private expectToken(type: TokenType): Token {
    return this.expect(type);
  }

  private expectValue(...types: TokenType[]): string {
    const token = this.nextToken();
    if (!token || !types.includes(token.type)) {
      throw this.error(`Expected one of [${types.join(',')}], got ${token?.type ?? 'EOF'}`);
    }
    return token.value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private nextToken(): Token | undefined {
    return this.tokens[this.pos++];
  }

  private error(msg: string): Error {
    return new Error(`Expression parse error at position ${this.pos}: ${msg}`);
  }

  private convertOperator(op: string): string {
    switch (op) {
      case '=': return 'eq';
      case '!=': case '<>': return 'neq';
      case '>': return 'gt';
      case '>=': return 'gte';
      case '<': return 'lt';
      case '<=': return 'lte';
      default: return op;
    }
  }

  // ===================== 词法分析 =====================

  private tokenize(expression: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    const len = expression.length;

    while (i < len) {
      const ch = expression[i];

      // 跳过空白
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        i++;
        continue;
      }

      // 字符串字面量
      if (ch === '\'' || ch === '"') {
        const quote = ch;
        let str = '';
        i++;
        while (i < len && expression[i] !== quote) {
          if (expression[i] === '\\' && i + 1 < len) {
            i++;
            str += expression[i];
          } else {
            str += expression[i];
          }
          i++;
        }
        i++; // 跳过结束引号
        tokens.push({ type: 'STRING', value: str });
        continue;
      }

      // 数字
      if (ch >= '0' && ch <= '9') {
        let num = '';
        while (i < len && ((expression[i] >= '0' && expression[i] <= '9') || expression[i] === '.')) {
          num += expression[i];
          i++;
        }
        tokens.push({ type: 'NUMBER', value: num });
        continue;
      }

      // 负数 (前面没有 IDENT/STRING/NUMBER/RPAREN)
      if (ch === '-' && i + 1 < len && expression[i + 1] >= '0' && expression[i + 1] <= '9') {
        const lastToken = tokens[tokens.length - 1];
        if (!lastToken || (lastToken.type !== 'IDENT' && lastToken.type !== 'STRING' && lastToken.type !== 'NUMBER' && lastToken.type !== 'RPAREN')) {
          let num = '-';
          i++;
          while (i < len && ((expression[i] >= '0' && expression[i] <= '9') || expression[i] === '.')) {
            num += expression[i];
            i++;
          }
          tokens.push({ type: 'NUMBER', value: num });
          continue;
        }
      }

      // 运算符
      if (ch === '!' && i + 1 < len && expression[i + 1] === '=') {
        tokens.push({ type: 'OP', value: '!=' });
        i += 2;
        continue;
      }
      if (ch === '<' && i + 1 < len && expression[i + 1] === '>') {
        tokens.push({ type: 'OP', value: '<>' });
        i += 2;
        continue;
      }
      if (ch === '>' && i + 1 < len && expression[i + 1] === '=') {
        tokens.push({ type: 'OP', value: '>=' });
        i += 2;
        continue;
      }
      if (ch === '<' && i + 1 < len && expression[i + 1] === '=') {
        tokens.push({ type: 'OP', value: '<=' });
        i += 2;
        continue;
      }
      if (ch === '=' || ch === '>' || ch === '<') {
        tokens.push({ type: 'OP', value: ch });
        i++;
        continue;
      }

      // 括号和逗号
      if (ch === '(') { tokens.push({ type: 'LPAREN', value: '(' }); i++; continue; }
      if (ch === ')') { tokens.push({ type: 'RPAREN', value: ')' }); i++; continue; }
      if (ch === ',') { tokens.push({ type: 'COMMA', value: ',' }); i++; continue; }

      // 标识符 (字段名、关键字)
      if (this.isIdentStart(ch)) {
        let ident = '';
        while (i < len && this.isIdentPart(expression[i])) {
          ident += expression[i];
          i++;
        }
        tokens.push({ type: 'IDENT', value: ident });
        continue;
      }

      throw new Error(`Unexpected character "${ch}" at position ${i}`);
    }

    return tokens;
  }

  private isIdentStart(ch: string): boolean {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
  }

  private isIdentPart(ch: string): boolean {
    return this.isIdentStart(ch) || (ch >= '0' && ch <= '9') || ch === '.';
  }
}

type TokenType = 'IDENT' | 'STRING' | 'NUMBER' | 'OP' | 'LPAREN' | 'RPAREN' | 'COMMA';

interface Token {
  type: TokenType;
  value: string;
}
