import { type Term } from '@zucker-framework/core';
import { TermExpressionParser } from '../expression/term-expression-parser';
import { type DynamicQueryParam } from '../dynamic-query.service';

/**
 * DynamicQueryParam 的增强封装类
 * - 静态工厂方法: of(), newQuery()
 * - 链式操作: noPaging(), doNotSort(), clone(), rePaging(total)
 * - 嵌套查询转换: toNestQuery()
 * - DSL 构建: and(), or()
 *
 * 内部以 terms 为唯一权威表示，where/filter/filters 只是输入或序列化形式。
 */
export class QueryParamEntity implements DynamicQueryParam {
  private _filters?: string;
  private _where?: string;
  private _filter?: Record<string, unknown>;

  orderBy?: string;
  page?: number;
  pageSize?: number;
  total?: number;
  includes?: string[];
  excludes?: string[];
  parallelPager?: boolean;
  inferTotal?: boolean;

  private _terms: Term[] = [];
  private _termsInitialized = false;
  private _noPaging = false;
  private _noSort = false;

  constructor(param?: DynamicQueryParam) {
    if (param) {
      this.orderBy = param.orderBy;
      this.page = param.page;
      this.pageSize = param.pageSize;
      this.total = param.total;
      this.includes = param.includes ? [...param.includes] : undefined;
      this.excludes = param.excludes ? [...param.excludes] : undefined;
      this.parallelPager = param.parallelPager;
      this.inferTotal = param.inferTotal;

      if (param.filters !== undefined) {
        // An object filter map (POST body) is kept in its JSON form.
        this.filters = typeof param.filters === 'string' ? param.filters : JSON.stringify(param.filters);
      }
      if (param.where !== undefined) {
        this.where = param.where;
      }
      if (param.filter !== undefined) {
        this.filter = this.cloneValue(param.filter);
      }
      if (param.terms !== undefined) {
        this.terms = param.terms;
      }
    }
  }

  get filters(): string | undefined {
    return this._filters;
  }

  set filters(value: string | undefined) {
    this._filters = value;
    this._where = undefined;
    this._filter = undefined;

    if (!value) {
      this._terms = [];
      this._termsInitialized = true;
      return;
    }

    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      this._terms = TermExpressionParser.parseMap(parsed);
    } catch {
      this._terms = [];
    }

    this._termsInitialized = true;
  }

  get where(): string | undefined {
    return this._where;
  }

  set where(value: string | undefined) {
    this._where = value;
    this._filters = undefined;
    this._filter = undefined;
    this._terms = value && value.trim().length > 0
      ? new TermExpressionParser().parse(value)
      : [];
    this._termsInitialized = true;
  }

  get filter(): Record<string, unknown> | undefined {
    return this._filter;
  }

  set filter(value: Record<string, unknown> | undefined) {
    this._filter = value ? this.cloneValue(value) : undefined;
    this._filters = undefined;
    this._where = undefined;
    this._terms = this._filter ? TermExpressionParser.parseMap(this._filter) : [];
    this._termsInitialized = true;
  }

  get terms(): Term[] | undefined {
    const terms = this.getTerms();
    return terms.length > 0 ? terms : undefined;
  }

  set terms(value: Term[] | undefined) {
    this._terms = value ? value.map((term) => this.cloneTerm(term)) : [];
    this._termsInitialized = true;
    this._where = undefined;
    this._filters = undefined;
    this._filter = this._terms.length > 0
      ? this.serializeTermsToFilterMap(this._terms)
      : undefined;
  }

  // ===================== 静态工厂方法 =====================

  /**
   * 创建一个空的查询参数实体
   */
  static of(): QueryParamEntity;
  /**
   * 基于已有参数创建查询参数实体
   */
  static of(param: DynamicQueryParam): QueryParamEntity;
  /**
   * 创建带单个 eq 条件的查询参数
   */
  static of(field: string, value: unknown): QueryParamEntity;
  static of(fieldOrParam?: string | DynamicQueryParam, value?: unknown): QueryParamEntity {
    if (fieldOrParam === undefined) {
      return new QueryParamEntity();
    }
    if (typeof fieldOrParam === 'string') {
      return new QueryParamEntity().and(fieldOrParam, 'eq', value);
    }
    if (fieldOrParam instanceof QueryParamEntity) {
      return fieldOrParam.clone();
    }
    return new QueryParamEntity(fieldOrParam);
  }

  /**
   * 创建新的链式查询构建器
   */
  static newQuery(): QueryParamEntity {
    return new QueryParamEntity();
  }

  // ===================== 链式 DSL 构建 =====================

  /**
   * 添加 AND 条件
   * @param column 字段名
   * @param termType 操作符 (eq, like, gt, in, etc.)
   * @param value 值
   */
  and(column: string, termType: string, value: unknown): this {
    this.ensureTermsInitialized();
    this._terms.push({ column, termType, value, type: 'and' });
    this.syncFilterFromTerms();
    return this;
  }

  /**
   * 添加 OR 条件
   */
  or(column: string, termType: string, value: unknown): this {
    this.ensureTermsInitialized();
    this._terms.push({ column, termType, value, type: 'or' });
    this.syncFilterFromTerms();
    return this;
  }

  /**
   * 将已有条件包装到嵌套条件里，并返回自身用于继续添加外层条件。
   */
  toNestQuery(): this {
    const currentTerms = this.getTerms().map((term) => this.cloneTerm(term));
    if (currentTerms.length === 0) {
      return this;
    }

    this._terms = [{
      column: '',
      termType: 'nest',
      value: null,
      type: 'and',
      terms: currentTerms,
    }];
    this._termsInitialized = true;
    this.syncFilterFromTerms();

    return this;
  }

  // ===================== 分页与排序 =====================

  /** 禁用分页，查询全部数据 */
  noPaging(): this {
    this._noPaging = true;
    this.page = undefined;
    this.pageSize = undefined;
    return this;
  }

  /** 禁用排序 */
  doNotSort(): this {
    this._noSort = true;
    this.orderBy = undefined;
    return this;
  }

  /** 深拷贝当前查询参数 */
  clone(): QueryParamEntity {
    const cloned = new QueryParamEntity();
    cloned._filters = this._filters;
    cloned._where = this._where;
    cloned._filter = this._filter ? this.cloneValue(this._filter) : undefined;
    cloned.orderBy = this.orderBy;
    cloned.page = this.page;
    cloned.pageSize = this.pageSize;
    cloned.total = this.total;
    cloned.includes = this.includes ? [...this.includes] : undefined;
    cloned.excludes = this.excludes ? [...this.excludes] : undefined;
    cloned.parallelPager = this.parallelPager;
    cloned.inferTotal = this.inferTotal;
    cloned._noPaging = this._noPaging;
    cloned._noSort = this._noSort;
    cloned._terms = this.getTerms().map((term) => this.cloneTerm(term));
    cloned._termsInitialized = this._termsInitialized;
    return cloned;
  }

  /**
   * 根据总数重新计算分页
   * 根据总数重新分页：
   * - 缓存 total 到实例，后续分页查询跳过 count
   * - 如果当前页超过总页数，自动跳转到最后一页
   */
  rePaging(total: number): this {
    this.total = total;
    if (this.page && this.pageSize) {
      const totalPages = Math.ceil(total / this.pageSize);
      if (this.page > totalPages && totalPages > 0) {
        this.page = totalPages;
      }
    }
    return this;
  }

  /** 设置分页参数 */
  withPage(page: number, pageSize?: number): this {
    this._noPaging = false;
    this.page = page;
    if (pageSize !== undefined) {
      this.pageSize = pageSize;
    }
    return this;
  }

  /** 设置排序 */
  withOrderBy(orderBy: string): this {
    this._noSort = false;
    this.orderBy = orderBy;
    return this;
  }

  /** 添加过滤条件 */
  withFilter(key: string, value: unknown): this {
    const nextFilter = {
      ...(this._filter ? this.cloneValue(this._filter) : this.serializeTermsToFilterMap(this.getTerms())),
      [key]: value,
    };
    this.filter = nextFilter;
    return this;
  }

  /** 设置 includes（要查询的列） */
  withIncludes(...fields: string[]): this {
    this.includes = fields;
    return this;
  }

  /** 设置 excludes（不查询的列） */
  withExcludes(...fields: string[]): this {
    this.excludes = fields;
    return this;
  }

  /** 是否禁用分页 */
  get isPagingDisabled(): boolean {
    return this._noPaging;
  }

  /** 是否禁用排序 */
  get isSortDisabled(): boolean {
    return this._noSort;
  }

  /**
   * 获取 0 基索引的页码（用于 PagerResult）
   */
  getThinkPageIndex(): number {
    return Math.max((this.page ?? 1) - 1, 0);
  }

  getTerms(): Term[] {
    this.ensureTermsInitialized();
    return this._terms;
  }

  // ===================== 内部方法 =====================

  private ensureTermsInitialized(): void {
    if (this._termsInitialized) {
      return;
    }

    if (this._where && this._where.trim().length > 0) {
      this._terms = new TermExpressionParser().parse(this._where);
    } else if (this._filter && Object.keys(this._filter).length > 0) {
      this._terms = TermExpressionParser.parseMap(this._filter);
    } else if (this._filters) {
      try {
        const parsed = JSON.parse(this._filters) as Record<string, unknown>;
        this._terms = TermExpressionParser.parseMap(parsed);
      } catch {
        this._terms = [];
      }
    } else {
      this._terms = [];
    }

    this._termsInitialized = true;
  }

  /** 将 _terms 同步到 filter map 格式 */
  private syncFilterFromTerms(): void {
    this._filter = this._terms.length > 0
      ? this.serializeTermsToFilterMap(this._terms)
      : undefined;
    this._where = undefined;
    this._filters = undefined;
    this._termsInitialized = true;
  }

  private serializeTermsToFilterMap(terms: Term[]): Record<string, unknown> {
    const filter: Record<string, unknown> = {};

    for (const term of terms) {
      if (term.termType === 'nest') {
        const nested = this.serializeTermsToFilterMap(term.terms ?? []);
        if (Object.keys(nested).length > 0) {
          filter[term.type === 'or' ? '$orNest' : '$nest'] = nested;
        }
        continue;
      }

      if (!term.column) {
        continue;
      }

      const prefix = term.type === 'or' ? '$or$' : '';
      const key = term.termType === 'eq'
        ? `${prefix}${term.column}`
        : `${prefix}${term.column}$${term.termType}`;
      filter[key] = term.value;
    }

    return filter;
  }

  private cloneTerm(term: Term): Term {
    return {
      column: term.column,
      termType: term.termType,
      value: this.cloneValue(term.value),
      type: term.type,
      terms: term.terms?.map((item) => this.cloneTerm(item)),
    };
  }

  private cloneValue<T>(value: T): T {
    if (value === undefined || value === null) {
      return value;
    }
    return JSON.parse(JSON.stringify(value)) as T;
  }
}
