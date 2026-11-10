import { Injectable, Inject, Logger, Optional, BadRequestException } from '@nestjs/common';
import { type DatabaseAdapter, type ModelFieldInfo, type Term } from '@zucker-framework/core';
import { FilterOperatorFactory, normalizeOperatorType } from './operators';
import {
  CRUD_QUERY_POLICY,
  type CrudQueryPolicy,
  assertFilterValue,
  assertQueryField,
  isRawFilterField,
  mergeQueryPolicy,
  resolveMaxFilterConditions,
  resolveMaxFilterDepth,
  resolveMaxPageSize,
  resolveMaxUnpagedRows,
  modelFieldsOf,
  stripRelationLikeIncludes,
  withModelFields,
} from './query/query-policy';
import { resolvePageTotal, type PaginatedResult } from './pagination';
import { DATABASE_ADAPTER } from './crud.module';
import { TermExpressionParser } from './expression/term-expression-parser';

/** Re-export Term as QueryTerm for consumers of this module */
export type QueryTerm = Term;

/**
 * Dynamic query parameter — describes filter, sort, pagination, and field selection
 * for dynamic queries.
 *
 * @example
 * ```ts
 * const query: DynamicQueryParam = {
 *   filters: '{"name$like":"Alice"}',
 *   orderBy: 'createdAt desc',
 *   page: 1,
 *   pageSize: 20,
 * };
 * ```
 */
export interface DynamicQueryParam {
  /** JSON-encoded filter map (e.g., '{"name$like":"value"}'); POST bodies may send the object. */
  filters?: string | Record<string, unknown>;
  /** Raw where clause string */
  where?: string;
  /** Structured filter object */
  filter?: Record<string, unknown>;
  /** Sort expression (e.g., 'createdAt desc,name asc') */
  orderBy?: string;
  /** Page number (1-based) */
  page?: number;
  /** Page index (0-based), 与 page 二选一，pageIndex 优先级高于 page */
  pageIndex?: number;
  /** Number of items per page */
  pageSize?: number;
  /** Pre-computed total count (skips COUNT query when provided) */
  total?: number;
  /** Fields to include in the result */
  includes?: string[];
  /** Fields to exclude from the result */
  excludes?: string[];
  /** Whether to run COUNT and SELECT queries in parallel */
  parallelPager?: boolean;
  /** Opt in to SELECT-first counting. Requires stable ordering; see README consistency limits.
   * Ignored when total is supplied or parallelPager is true. */
  inferTotal?: boolean;
  /** Structured Term conditions  */
  terms?: Term[];
}

/** Extra, trusted options for {@link DynamicQueryService.findMany}. */
export interface DynamicQueryOptions {
  /** Service policy merged over the module default ({@link CRUD_QUERY_POLICY}). */
  policy?: CrudQueryPolicy;
}

/** Projection arguments produced from includes / excludes. */
export type QueryProjection =
  | { select: Record<string, boolean> }
  | { omit: Record<string, boolean> }
  | Record<string, never>;

/** Coerce a query-string number (`"2"`) to a number; reject non-numeric input with 400. */
function toOptionalNumber(name: string, value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  if (!Number.isFinite(parsed)) throw new BadRequestException(`${name} must be a number`);
  return parsed;
}

/** Accept `includes=a,b` from a query string as well as an array. */
function toFieldList(name: string, value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  if (Array.isArray(value)) return value as string[];
  throw new BadRequestException(`${name} must be a list of field names`);
}

function toFlag(value: unknown): boolean {
  return value === true || value === 'true' || value === '1';
}

/** Normalize the loosely-typed query (GET query strings arrive as strings). */
export function normalizeDynamicQueryParam(query: DynamicQueryParam = {}): DynamicQueryParam {
  const raw = query as Record<string, unknown>;
  return {
    ...query,
    page: toOptionalNumber('page', raw.page),
    pageIndex: toOptionalNumber('pageIndex', raw.pageIndex),
    pageSize: toOptionalNumber('pageSize', raw.pageSize),
    total: toOptionalNumber('total', raw.total),
    includes: toFieldList('includes', raw.includes),
    excludes: toFieldList('excludes', raw.excludes),
    parallelPager: toFlag(raw.parallelPager),
    inferTotal: toFlag(raw.inferTotal),
  };
}

/**
 * Service for parsing dynamic query parameters into Prisma-compatible query arguments.
 * Handles filter maps, sort expressions, pagination, and field selection.
 *
 * Caller-supplied input is validated against a {@link CrudQueryPolicy}: plain scalar field names only,
 * no sensitive fields, known operators only and scalar values only (400 otherwise).
 */
@Injectable()
export class DynamicQueryParamService {
  private readonly logger = new Logger(DynamicQueryParamService.name);

  constructor(private readonly operatorFactory: FilterOperatorFactory) {}

  /**
   * 解析查询条件（filter map 格式: {"name$like": "张三"}）
   *
   * 支持：
   * - 普通字段：{ "name$like": "张三" } → AND 条件
   * - OR 前缀：{ "$or$role": "admin" } → OR 条件（与同级其他条件 OR）
   * - 嵌套 AND 组：{ "$nest": { ... } } → 递归解析，AND 到外层
   * - 嵌套 OR 组：{ "$orNest": { ... } } → 递归解析，OR 到外层
   */
  parseFilters(filters: Record<string, unknown> = {}, policy?: CrudQueryPolicy): Record<string, unknown> {
    const budget = { remaining: resolveMaxFilterConditions(policy) };
    return this.parseFilterLevel(filters, policy, 0, budget);
  }

  private parseFilterLevel(
    filters: Record<string, unknown>,
    policy: CrudQueryPolicy | undefined,
    depth: number,
    budget: { remaining: number },
  ): Record<string, unknown> {
    if (typeof filters !== 'object' || filters === null || Array.isArray(filters)) {
      throw new BadRequestException('filters must be an object');
    }
    if (depth > resolveMaxFilterDepth(policy)) throw new BadRequestException('filters are nested too deeply');
    const andConditions: Record<string, unknown>[] = [];
    const orConditions: Record<string, unknown>[] = [];
    let hasOrTerms = false;

    for (const [key, value] of Object.entries(filters)) {
      if (value === undefined || value === null || value === '') continue;
      if (--budget.remaining < 0) throw new BadRequestException('Too many filter conditions');

      // $nest → nested AND group
      if (key === '$nest' && typeof value === 'object' && !Array.isArray(value)) {
        const nested = this.parseFilterLevel(value as Record<string, unknown>, policy, depth + 1, budget);
        if (Object.keys(nested).length > 0) andConditions.push(nested);
        continue;
      }

      // $orNest → nested OR group
      if (key === '$orNest' && typeof value === 'object' && !Array.isArray(value)) {
        const nested = this.parseFilterLevel(value as Record<string, unknown>, policy, depth + 1, budget);
        if (Object.keys(nested).length > 0) {
          orConditions.push(nested);
          hasOrTerms = true;
        }
        continue;
      }

      // $or$field[$op] → OR-type condition
      let isOrType = false;
      let fieldKey = key;
      if (key.startsWith('$or$')) {
        isOrType = true;
        fieldKey = key.slice(4); // strip '$or$'
      }

      const dollarIdx = fieldKey.indexOf('$');
      const field = dollarIdx >= 0 ? fieldKey.slice(0, dollarIdx) : fieldKey;
      const op = dollarIdx >= 0 ? fieldKey.slice(dollarIdx + 1) : 'eq';
      // Malformed keys (`$nest` with a non-object, `$foo$bar`, `$eq`) are rejected, not skipped.
      if (!field) throw new BadRequestException(`Invalid filter key: ${key.slice(0, 64)}`);

      const result = this.applyUserFilter(field, op || 'eq', value, policy);
      if (result && Object.keys(result).length > 0) {
        if (isOrType) {
          hasOrTerms = true;
          orConditions.push(result);
        } else {
          andConditions.push(result);
        }
      }
    }

    // 混合 AND + OR：AND 条件之间用 AND 合并，OR 条件用 OR 合并，再用 AND 组合
    // 语义: (AND1 AND AND2) AND (OR1 OR OR2)
    if (hasOrTerms) {
      const parts: Record<string, unknown>[] = [];

      // AND 条件合并
      if (andConditions.length === 1) {
        parts.push(andConditions[0]);
      } else if (andConditions.length > 1) {
        parts.push({ AND: andConditions });
      }

      // OR 条件合并
      if (orConditions.length === 1) {
        parts.push(orConditions[0]);
      } else if (orConditions.length > 1) {
        parts.push({ OR: orConditions });
      }

      if (parts.length === 0) return {};
      if (parts.length === 1) return parts[0];
      return { AND: parts };
    }

    // All AND conditions
    if (andConditions.length === 0) return {};
    if (andConditions.length === 1) return andConditions[0];
    return { AND: andConditions };
  }

  /**
   * Validate and apply one caller-supplied condition. Fields listed in `policy.rawFilterFields`
   * keep the legacy raw passthrough (object values / unknown operators) as an explicit opt-in.
   */
  private applyUserFilter(
    field: string,
    op: string,
    value: unknown,
    policy?: CrudQueryPolicy,
  ): Record<string, unknown> | null {
    assertQueryField(field, 'filter', policy);
    const canonical = normalizeOperatorType(op);
    const known = this.operatorFactory.getOperator(canonical);
    if (isRawFilterField(field, policy) && (!known || (typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)))) {
      return { [field]: value };
    }
    if (!known) throw new BadRequestException(`Unsupported filter operator: ${op.slice(0, 32)}`);
    if (policy?.allowedOperators && !policy.allowedOperators.includes(canonical)) {
      throw new BadRequestException(`Filter operator "${canonical}" is not allowed`);
    }
    assertFilterValue(field, value);
    return known.apply(field, value);
  }

  /**
   * 解析排序
   * @param orderBy 排序字符串，格式：'field1 desc,field2 asc'
   * @param defaultField 默认排序字段（服务端可信，不受策略限制）
   * @param policy 调用方字段策略
   */
  parseOrderBy(orderBy?: string, defaultField?: string, policy?: CrudQueryPolicy): Record<string, string>[] {
    const field = defaultField || 'createdAt';
    if (orderBy !== undefined && orderBy !== null && typeof orderBy !== 'string') {
      throw new BadRequestException('orderBy must be a string');
    }
    if (!orderBy || orderBy.trim().length === 0) return [{ [field]: 'desc' }];

    const parts = orderBy.split(',')
      .map((order) => order.trim())
      .filter((order) => order.length > 0);
    if (parts.length > 10) throw new BadRequestException('Too many orderBy fields');
    return parts.map((order) => {
      const [orderField, direction, ...rest] = order.split(/\s+/);
      if (!orderField) return { [field]: 'desc' };
      if (rest.length > 0) throw new BadRequestException(`Invalid orderBy: ${order.slice(0, 64)}`);
      assertQueryField(orderField, 'sort', policy);
      return { [orderField]: direction?.toLowerCase() === 'desc' ? 'desc' : 'asc' };
    });
  }

  /**
   * 解析分页参数
   */
  parsePagination(page: number = 1, pageSize: number = 10): { skip: number; take: number } {
    const safePage = Math.max(1, Math.floor(page));
    const safePageSize = Math.max(1, Math.floor(pageSize));
    return {
      skip: (safePage - 1) * safePageSize,
      take: safePageSize,
    };
  }

  /**
   * 解析字段选择（兼容接口）。新代码请使用 {@link parseProjection}：仅 excludes 时
   * Prisma 不接受全 false 的 select，需要 omit。
   */
  parseSelect(includes?: string[], excludes?: string[], policy?: CrudQueryPolicy): Record<string, boolean> | undefined {
    if (!includes?.length && !excludes?.length) return undefined;

    const select: Record<string, boolean> = {};

    if (includes?.length) {
      includes.forEach((field) => (select[assertQueryField(field, 'select', policy)] = true));
    }

    if (excludes?.length) {
      excludes.forEach((field) => (select[assertQueryField(field, 'select', { sensitiveFieldPattern: false })] = false));
    }

    return select;
  }

  /**
   * Build Prisma projection args.
   * - includes → `select` of the included scalar fields minus excluded / denied ones;
   * - excludes only → `omit` (an all-false `select` is rejected by Prisma).
   * Included fields are validated against the policy (no relations by default when an allow-list is
   * set, never sensitive fields); excluded fields only need to be plain identifiers.
   */
  parseProjection(includes?: string[], excludes?: string[], policy?: CrudQueryPolicy): QueryProjection {
    const excluded = new Set(
      (excludes ?? []).map((field) => assertQueryField(field, 'select', { sensitiveFieldPattern: false })),
    );
    if (includes?.length) {
      if (includes.length > 200) throw new BadRequestException('Too many includes');
      const select: Record<string, boolean> = {};
      for (const field of includes) {
        assertQueryField(field, 'select', policy);
        if (!excluded.has(field)) select[field] = true;
      }
      if (Object.keys(select).length === 0) throw new BadRequestException('includes selects no field');
      return { select };
    }
    if (excluded.size > 0) {
      // omit only accepts scalar columns; with metadata, drop excluded names that are not.
      const fields = modelFieldsOf(policy);
      const omitted = fields
        ? [...excluded].filter((field) => {
            const info = fields.get(field);
            return info && (info.kind === 'scalar' || info.kind === 'enum');
          })
        : [...excluded];
      if (omitted.length === 0) return {};
      return { omit: Object.fromEntries(omitted.map((field) => [field, true])) };
    }
    return {};
  }

  /**
   * 将 Term[] 转换为 Prisma WHERE 条件
   *
   * Term 是 Zucker 统一的过滤条件格式（column + termType + value），
   * 由 DataAccessHandler 生成，需注入到查询中以实现行级数据权限。
   *
   * @param terms 过滤条件
   * @param policy 调用方策略；为 undefined 时视为可信 term（DataAccess 产生），只做操作符解析
   * @returns Prisma 兼容的 WHERE 条件对象
   */
  termsToWhere(terms: Term[], policy?: CrudQueryPolicy): Record<string, unknown> {
    const budget = { remaining: resolveMaxFilterConditions(policy) };
    return this.termsLevel(terms, policy, 0, budget);
  }

  /** Same as {@link termsToWhere} but always validates as caller input (default policy when none given). */
  userTermsToWhere(terms: Term[], policy: CrudQueryPolicy = {}): Record<string, unknown> {
    return this.termsToWhere(terms, policy);
  }

  private termsLevel(
    terms: Term[],
    policy: CrudQueryPolicy | undefined,
    depth: number,
    budget: { remaining: number },
  ): Record<string, unknown> {
    if (!terms || terms.length === 0) return {};
    if (!Array.isArray(terms)) throw new BadRequestException('terms must be an array');
    if (policy && depth > resolveMaxFilterDepth(policy)) throw new BadRequestException('terms are nested too deeply');

    const conditions: Record<string, unknown>[] = [];

    for (const term of terms) {
      if (typeof term !== 'object' || term === null) throw new BadRequestException('Invalid term');
      if (policy && --budget.remaining < 0) throw new BadRequestException('Too many filter conditions');
      // 'nest' 类型 term 只处理嵌套子条件，不对自身 apply operator
      if (term.termType === 'nest' || (term.column === '' && term.terms?.length)) {
        if (term.terms && term.terms.length > 0) {
          const nested = this.termsLevel(term.terms, policy, depth + 1, budget);
          if (Object.keys(nested).length > 0) conditions.push(nested);
        }
        continue;
      }

      const result = policy
        ? this.applyUserFilter(term.column, term.termType || 'eq', term.value, policy)
        : this.operatorFactory.applyFilter(term.column, term.termType, term.value);
      if (result) conditions.push(result);

      // 递归处理嵌套 terms（非 nest 类型的附加子条件）
      if (term.terms && term.terms.length > 0) {
        const nested = this.termsLevel(term.terms, policy, depth + 1, budget);
        if (Object.keys(nested).length > 0) conditions.push(nested);
      }
    }

    if (conditions.length === 0) return {};
    if (conditions.length === 1) return conditions[0];

    // 任意 term 有 type:'or' → 整组用 OR；否则用 AND
    const hasOrTerm = terms.some((t) => t.type === 'or');
    return hasOrTerm ? { OR: conditions } : { AND: conditions };
  }
}

/**
 * Service for executing dynamic queries with automatic filter parsing,
 * sorting, pagination, and field selection. Supports parallel paging
 * and total count reuse for optimized queries.
 */
@Injectable()
export class DynamicQueryService {
  private readonly logger = new Logger(DynamicQueryService.name);

  /** model → field metadata (null: adapter has none). */
  private readonly modelFieldCache = new Map<string, ReadonlyMap<string, ModelFieldInfo> | null>();
  private readonly strippedWarned = new Set<string>();

  constructor(
    @Inject(DATABASE_ADAPTER) private readonly db: DatabaseAdapter,
    private readonly dynamicQueryParam: DynamicQueryParamService,
    @Optional() @Inject(CRUD_QUERY_POLICY) private readonly defaultPolicy?: CrudQueryPolicy,
  ) {}

  /** Effective `pageSize` upper bound for a service policy merged over the module default. */
  maxPageSizeFor(policy?: CrudQueryPolicy): number {
    return resolveMaxPageSize(mergeQueryPolicy(this.defaultPolicy, policy));
  }

  /** Field metadata for `model` from the adapter, resolved once per model. */
  private fieldsFor(model: string): ReadonlyMap<string, ModelFieldInfo> | undefined {
    if (!this.modelFieldCache.has(model)) {
      let fields: readonly ModelFieldInfo[] | undefined;
      try {
        fields = this.db.getModelFields?.(model);
      } catch (error) {
        this.logger.warn(`getModelFields(${model}) failed: ${(error as Error).message}`);
      }
      this.modelFieldCache.set(model, fields?.length ? new Map(fields.map((field) => [field.name, field])) : null);
    }
    return this.modelFieldCache.get(model) ?? undefined;
  }

  /** Effective caller policy for `model`: module default + service policy + field metadata. */
  callerPolicy(model: string, policy?: CrudQueryPolicy): CrudQueryPolicy {
    return this.effectivePolicy(model, policy);
  }

  private effectivePolicy(model: string, policy?: CrudQueryPolicy): CrudQueryPolicy {
    return withModelFields(mergeQueryPolicy(this.defaultPolicy, policy), this.fieldsFor(model));
  }

  /** Without metadata, drop relation-like included values (secure default for `includes`). */
  private stripIncludes<T>(model: string, rows: T[], includes: string[] | undefined, policy: CrudQueryPolicy): T[] {
    return stripRelationLikeIncludes(rows, includes, policy, (fields) => {
      if (this.strippedWarned.has(model) || this.strippedWarned.size > 1000) return;
      this.strippedWarned.add(model);
      this.logger.warn(
        `${model}: removed non-scalar values of included fields [${fields.join(', ')}]. Relations (and JSON columns, ` +
          'when the adapter has no field metadata) must be listed in queryPolicy.selectableFields to be returned.',
      );
    });
  }

  /** Resolve the user WHERE from any of the four caller filter representations. */
  parseUserWhere(queryParam: DynamicQueryParam, policy?: CrudQueryPolicy, model?: string): Record<string, unknown> {
    const effective = model ? this.effectivePolicy(model, policy) : mergeQueryPolicy(this.defaultPolicy, policy);
    const { filters, filter, where: whereExpr, terms } = queryParam;
    // Resolve user WHERE: terms > whereExpr > filter object > filters JSON string
    if (terms !== undefined && terms !== null && !Array.isArray(terms)) {
      throw new BadRequestException('terms must be an array');
    }
    if (terms && terms.length > 0) {
      return this.dynamicQueryParam.termsToWhere(terms, effective);
    }
    if (whereExpr) {
      if (typeof whereExpr !== 'string') throw new BadRequestException('where must be a string');
      let parsed: unknown;
      try {
        parsed = new TermExpressionParser().parse(whereExpr);
      } catch (error) {
        throw new BadRequestException(`Invalid where expression: ${(error as Error).message}`.slice(0, 200));
      }
      return this.dynamicQueryParam.termsToWhere(parsed as Term[], effective);
    }
    if (filter !== undefined && filter !== null) {
      if (typeof filter !== 'object' || Array.isArray(filter)) throw new BadRequestException('filter must be an object');
      if (Object.keys(filter).length > 0) return this.dynamicQueryParam.parseFilters(filter, effective);
    }
    if (filters) {
      let parsed: unknown;
      if (typeof filters === 'object') {
        parsed = filters;
      } else {
        try {
          parsed = JSON.parse(String(filters));
        } catch {
          // Fail closed: an unparseable filter must never widen the result to the whole table.
          this.logger.warn(`Invalid filters JSON (length=${String(filters).length})`);
          throw new BadRequestException('filters must be valid JSON');
        }
      }
      return this.dynamicQueryParam.parseFilters(parsed as Record<string, unknown>, effective);
    }
    return {};
  }

  /**
   * 通用分页查询
   * @param model 模型名称
   * @param queryParam 查询参数（调用方输入，按策略校验）
   * @param defaultOrderField 默认排序字段
   * @param dataAccessTerms DataAccess 产生的过滤条件（由 DataPermissionGuard 注入，可信）
   * @param denyFields DataAccess 产生的禁止字段列表
   * @param requiredWhere Trusted service-owned constraints, ANDed with user and access filters
   * @param options Service query policy
   * @returns 分页查询结果
   */
  async findMany<T = unknown>(
    model: string,
    queryParam: DynamicQueryParam,
    defaultOrderField?: string,
    dataAccessTerms?: Term[],
    denyFields?: string[],
    requiredWhere?: Record<string, unknown>,
    options?: DynamicQueryOptions,
  ): Promise<PaginatedResult<T>> {
    const policy = this.effectivePolicy(model, options?.policy);
    const normalized = normalizeDynamicQueryParam(queryParam);
    const {
      orderBy, pageSize,
      includes, excludes,
      total: clientTotal, parallelPager,
    } = normalized;
    // 支持 pageIndex (0-based) 和 page (1-based)，pageIndex 优先
    const page = normalized.pageIndex !== undefined
      ? normalized.pageIndex + 1
      : normalized.page;

    const userWhere = this.parseUserWhere(normalized, options?.policy, model);

    // Merge DataAccess filterConditions into WHERE (trusted terms: operator parsing only)
    const accessWhere = dataAccessTerms
      ? this.dynamicQueryParam.termsToWhere(dataAccessTerms)
      : {};
    const scopedWhere = Object.keys(accessWhere).length > 0
      ? (Object.keys(userWhere).length > 0 ? { AND: [userWhere, accessWhere] } : accessWhere)
      : userWhere;
    // Trusted service constraints are ANDed after every user filter representation.
    const where = requiredWhere && Object.keys(requiredWhere).length
      ? { AND: [scopedWhere, requiredWhere] }
      : scopedWhere;

    const sort = this.dynamicQueryParam.parseOrderBy(orderBy, defaultOrderField, policy);

    // Merge denyFields into excludes
    const mergedExcludes = denyFields
      ? [...(excludes ?? []), ...denyFields.filter((f) => !(excludes ?? []).includes(f))]
      : excludes;
    const projection = this.dynamicQueryParam.parseProjection(includes, mergedExcludes, policy);

    const modelOps = this.db.model(model);

    // No-paging mode: when both page and pageSize are absent
    if (page === undefined && pageSize === undefined) {
      const limit = resolveMaxUnpagedRows(policy);
      const data = this.stripIncludes(model, await modelOps.findMany({
        where,
        orderBy: sort,
        ...(Number.isFinite(limit) ? { take: limit } : {}),
        ...projection,
      }) as T[], includes, policy);
      const truncated = Number.isFinite(limit) && data.length >= limit;
      if (truncated) {
        this.logger.warn(`Unpaged ${model} query reached the ${limit}-row limit; result may be truncated`);
      }

      return {
        data,
        total: data.length,
        page: 1,
        pageSize: data.length,
        totalPages: 1,
        pageIndex: 0,
        ...(truncated ? { truncated: true } : {}),
      };
    }

    const safePage = Math.max(1, Math.floor(page ?? 1));
    const safePageSize = Math.min(resolveMaxPageSize(policy), Math.max(1, Math.floor(pageSize ?? 10)));
    const pagination = this.dynamicQueryParam.parsePagination(safePage, safePageSize);

    // total 复用：前端传了 total 就跳过 count 查询
    if (clientTotal !== undefined && clientTotal >= 0) {
      const data = this.stripIncludes(model, await modelOps.findMany({
        where,
        orderBy: sort,
        ...pagination,
        ...projection,
      }) as T[], includes, policy);

      return {
        data,
        total: clientTotal,
        page: safePage,
        pageSize: safePageSize,
        totalPages: Math.ceil(clientTotal / safePageSize),
        pageIndex: safePage - 1,
      };
    }

    // 并行分页：count 和 findMany 并发执行
    if (parallelPager) {
      const [total, rows] = await Promise.all([
        modelOps.count({ where }),
        modelOps.findMany({
          where,
          orderBy: sort,
          ...pagination,
          ...projection,
        }) as Promise<T[]>,
      ]);
      const data = this.stripIncludes(model, rows, includes, policy);

      return {
        data,
        total,
        page: safePage,
        pageSize: safePageSize,
        totalPages: Math.ceil(total / safePageSize),
        pageIndex: safePage - 1,
      };
    }

    if (normalized.inferTotal) {
      const data = this.stripIncludes(model, await modelOps.findMany({
        where, orderBy: sort, ...pagination, ...projection,
      }) as T[], includes, policy);
      const total = await resolvePageTotal(data.length, pagination, () => modelOps.count({ where }));
      return { data, total, page: safePage, pageSize: safePageSize,
        totalPages: Math.ceil(total / safePageSize), pageIndex: safePage - 1 };
    }

    // 默认：先 count 再 findMany
    const total = await modelOps.count({ where });
    const data = this.stripIncludes(model, await modelOps.findMany({
      where,
      orderBy: sort,
      ...pagination,
      ...projection,
    }) as T[], includes, policy);

    return {
      data,
      total,
      page: safePage,
      pageSize: safePageSize,
      totalPages: Math.ceil(total / safePageSize),
      pageIndex: safePage - 1,
    };
  }

  /**
   * 查询单条记录
   */
  async findOne(
    model: string,
    id: string,
    includes?: string[],
    excludes?: string[],
    options?: DynamicQueryOptions,
  ) {
    const policy = this.effectivePolicy(model, options?.policy);
    const includeList = toFieldList('includes', includes);
    const projection = this.dynamicQueryParam.parseProjection(
      includeList, toFieldList('excludes', excludes), policy,
    );

    const row = await this.db.model(model).findUnique({
      where: { id },
      ...projection,
    });
    return row ? this.stripIncludes(model, [row], includeList, policy)[0] : row;
  }
}
