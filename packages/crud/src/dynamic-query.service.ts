import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { type DatabaseAdapter, type Term } from '@zucker/core';
import { FilterOperatorFactory } from './operators';
import { type PaginatedResult } from './pagination';
import { DATABASE_ADAPTER } from './crud.module';
import { TermExpressionParser } from './expression/term-expression-parser';

/** Re-export Term as QueryTerm for consumers of this module */
export type QueryTerm = Term;

/**
 * Dynamic query parameter — describes filter, sort, pagination, and field selection
 * for dynamic queries. Mirrors hsweb QueryParamEntity.
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
  /** JSON-encoded filter map (e.g., '{"name$like":"value"}') */
  filters?: string;
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
  /** Structured Term conditions (对齐 hsweb QueryParam.terms) */
  terms?: Term[];
}

/**
 * Service for parsing dynamic query parameters into Prisma-compatible query arguments.
 * Handles filter maps, sort expressions, pagination, and field selection.
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
  parseFilters(filters: Record<string, unknown> = {}): Record<string, unknown> {
    const andConditions: Record<string, unknown>[] = [];
    const orConditions: Record<string, unknown>[] = [];
    let hasOrTerms = false;

    for (const [key, value] of Object.entries(filters)) {
      if (value === undefined || value === null || value === '') continue;

      // $nest → nested AND group
      if (key === '$nest' && typeof value === 'object' && !Array.isArray(value)) {
        const nested = this.parseFilters(value as Record<string, unknown>);
        if (Object.keys(nested).length > 0) andConditions.push(nested);
        continue;
      }

      // $orNest → nested OR group
      if (key === '$orNest' && typeof value === 'object' && !Array.isArray(value)) {
        const nested = this.parseFilters(value as Record<string, unknown>);
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
        hasOrTerms = true;
        fieldKey = key.slice(4); // strip '$or$'
      }

      const dollarIdx = fieldKey.indexOf('$');
      const field = dollarIdx >= 0 ? fieldKey.slice(0, dollarIdx) : fieldKey;
      const op = dollarIdx >= 0 ? fieldKey.slice(dollarIdx + 1) : 'eq';
      if (!field) continue;

      const result = this.operatorFactory.applyFilter(field, op || 'eq', value);
      if (result && Object.keys(result).length > 0) {
        if (isOrType) {
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
   * 解析排序
   * @param orderBy 排序字符串，格式：'field1 desc,field2 asc'
   * @param defaultField 默认排序字段
   */
  parseOrderBy(orderBy?: string, defaultField?: string): Record<string, string>[] {
    const field = defaultField || 'createdAt';
    if (!orderBy || orderBy.trim().length === 0) return [{ [field]: 'desc' }];

    return orderBy.split(',')
      .map((order) => order.trim())
      .filter((order) => order.length > 0)
      .map((order) => {
        const [orderField, direction] = order.split(' ');
        if (!orderField) return { [field]: 'desc' };
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
   * 解析字段选择
   */
  parseSelect(includes?: string[], excludes?: string[]): Record<string, boolean> | undefined {
    if (!includes?.length && !excludes?.length) return undefined;

    const select: Record<string, boolean> = {};

    if (includes?.length) {
      includes.forEach((field) => (select[field] = true));
    }

    if (excludes?.length) {
      excludes.forEach((field) => (select[field] = false));
    }

    return select;
  }

  /**
   * 将 DataAccess Term[] 转换为 Prisma WHERE 条件
   *
   * Term 是 hsweb/zucker 统一的过滤条件格式（column + termType + value），
   * 由 DataAccessHandler 生成，需注入到查询中以实现行级数据权限。
   *
   * @param terms DataAccess 产生的过滤条件
   * @returns Prisma 兼容的 WHERE 条件对象
   */
  termsToWhere(terms: Term[]): Record<string, unknown> {
    if (!terms || terms.length === 0) return {};

    const conditions: Record<string, unknown>[] = [];

    for (const term of terms) {
      // 'nest' 类型 term 只处理嵌套子条件，不对自身 apply operator
      if (term.termType === 'nest' || (term.column === '' && term.terms?.length)) {
        if (term.terms && term.terms.length > 0) {
          const nested = this.termsToWhere(term.terms);
          if (Object.keys(nested).length > 0) conditions.push(nested);
        }
        continue;
      }

      const result = this.operatorFactory.applyFilter(
        term.column,
        term.termType,
        term.value,
      );
      if (result) conditions.push(result);

      // 递归处理嵌套 terms（非 nest 类型的附加子条件）
      if (term.terms && term.terms.length > 0) {
        const nested = this.termsToWhere(term.terms);
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

  constructor(
    @Inject(DATABASE_ADAPTER) private readonly db: DatabaseAdapter,
    private readonly dynamicQueryParam: DynamicQueryParamService,
  ) {}

  /**
   * 通用分页查询
   * @param model 模型名称
   * @param queryParam 查询参数
   * @param defaultOrderField 默认排序字段
   * @param dataAccessTerms DataAccess 产生的过滤条件（由 DataPermissionGuard 注入）
   * @param denyFields DataAccess 产生的禁止字段列表
   * @returns 分页查询结果
   */
  async findMany<T = unknown>(
    model: string,
    queryParam: DynamicQueryParam,
    defaultOrderField?: string,
    dataAccessTerms?: Term[],
    denyFields?: string[],
  ): Promise<PaginatedResult<T>> {
    const {
      filters, filter, where: whereExpr, terms,
      orderBy, pageSize,
      includes, excludes,
      total: clientTotal, parallelPager,
    } = queryParam;
    // 支持 pageIndex (0-based) 和 page (1-based)，pageIndex 优先
    const page = queryParam.pageIndex !== undefined
      ? queryParam.pageIndex + 1
      : queryParam.page;

    // Resolve user WHERE: terms > whereExpr > filter object > filters JSON string
    let userWhere: Record<string, unknown> = {};
    if (terms && terms.length > 0) {
      userWhere = this.dynamicQueryParam.termsToWhere(terms);
    } else if (whereExpr) {
      const parsed = new TermExpressionParser().parse(whereExpr);
      userWhere = this.dynamicQueryParam.termsToWhere(parsed as Term[]);
    } else if (filter && Object.keys(filter).length > 0) {
      userWhere = this.dynamicQueryParam.parseFilters(filter);
    } else if (filters) {
      try {
        userWhere = this.dynamicQueryParam.parseFilters(JSON.parse(filters));
      } catch {
        this.logger.warn(`Invalid filters JSON: ${filters.slice(0, 100)}`);
      }
    }

    // Merge DataAccess filterConditions into WHERE — 对齐 hsweb 数据权限注入
    const accessWhere = dataAccessTerms
      ? this.dynamicQueryParam.termsToWhere(dataAccessTerms)
      : {};
    const where = Object.keys(accessWhere).length > 0
      ? (Object.keys(userWhere).length > 0 ? { AND: [userWhere, accessWhere] } : accessWhere)
      : userWhere;

    const sort = this.dynamicQueryParam.parseOrderBy(orderBy, defaultOrderField);

    // Merge denyFields into excludes — 对齐 hsweb 字段级数据权限
    const mergedExcludes = denyFields
      ? [...(excludes ?? []), ...denyFields.filter((f) => !(excludes ?? []).includes(f))]
      : excludes;
    const select = this.dynamicQueryParam.parseSelect(includes, mergedExcludes);

    const modelOps = this.db.model(model);

    // No-paging mode: when both page and pageSize are absent
    if (page === undefined && pageSize === undefined) {
      const data = await modelOps.findMany({
        where,
        orderBy: sort,
        ...(select ? { select } : {}),
      }) as T[];

      return {
        data,
        total: data.length,
        page: 1,
        pageSize: data.length,
        totalPages: 1,
        pageIndex: 0,
      };
    }

    const safePage = Math.max(1, Math.floor(page ?? 1));
    const safePageSize = Math.max(1, Math.floor(pageSize ?? 10));
    const pagination = this.dynamicQueryParam.parsePagination(safePage, safePageSize);

    // total 复用：前端传了 total 就跳过 count 查询
    if (clientTotal !== undefined && clientTotal >= 0) {
      const data = await modelOps.findMany({
        where,
        orderBy: sort,
        ...pagination,
        ...(select ? { select } : {}),
      }) as T[];

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
      const [total, data] = await Promise.all([
        modelOps.count({ where }),
        modelOps.findMany({
          where,
          orderBy: sort,
          ...pagination,
          ...(select ? { select } : {}),
        }) as Promise<T[]>,
      ]);

      return {
        data,
        total,
        page: safePage,
        pageSize: safePageSize,
        totalPages: Math.ceil(total / safePageSize),
        pageIndex: safePage - 1,
      };
    }

    // 默认：先 count 再 findMany
    const total = await modelOps.count({ where });
    const data = await modelOps.findMany({
      where,
      orderBy: sort,
      ...pagination,
      ...(select ? { select } : {}),
    }) as T[];

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
  ) {
    const select = this.dynamicQueryParam.parseSelect(includes, excludes);

    return this.db.model(model).findUnique({
      where: { id },
      ...(select ? { select } : {}),
    });
  }
}
