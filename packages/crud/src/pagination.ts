/**
 * Pagination utilities for dynamic query results.
 */
import { type DynamicQueryParam } from './dynamic-query.service';

/**
 * Paginated query result containing data and pagination metadata.
 * Mirrors hsweb PagerResult<E>.
 * @template T - The type of each data item
 */
export interface PaginatedResult<T> {
  /** The data items for the current page */
  data: T[];
  /** Total number of matching records */
  total: number;
  /** Current page number (1-based) */
  page: number;
  /** Number of items per page */
  pageSize: number;
  /** Total number of pages */
  totalPages: number;
  /**
   * 0-based page index for hsweb PagerResult compatibility.
   * Equivalent to Java PagerResult.pageIndex = QueryParam.getThinkPageIndex()
   */
  pageIndex: number;
}

/**
 * SaveResult — mirrors hsweb SaveResult.
 * Represents the outcome of a batch save (upsert) operation.
 */
export interface SaveResult {
  /** Number of newly created records */
  created: number;
  /** Number of updated records */
  updated: number;
  /** Total number of affected records (created + updated) */
  total: number;
}

/**
 * Create an empty PaginatedResult.
 * Mirrors hsweb PagerResult.empty().
 */
export function emptyPagerResult<T>(): PaginatedResult<T> {
  return {
    data: [],
    total: 0,
    page: 1,
    pageSize: 0,
    totalPages: 0,
    pageIndex: 0,
  };
}

/**
 * Merge two SaveResults.
 * Mirrors hsweb SaveResult.merge().
 */
export function mergeSaveResult(a: SaveResult, b: SaveResult): SaveResult {
  return {
    created: a.created + b.created,
    updated: a.updated + b.updated,
    total: a.total + b.total,
  };
}

/**
 * Adjust pagination parameters based on total count.
 * If the current page exceeds total pages, automatically adjusts to the last page.
 * @param queryParam - The original query parameters
 * @param totalCount - The total number of matching records
 * @returns Adjusted query parameters with corrected page number
 */
export function rePaging(queryParam: DynamicQueryParam, totalCount: number): DynamicQueryParam {
  const page = Math.max(1, queryParam.page ?? 1);
  const pageSize = Math.max(1, queryParam.pageSize ?? 10);
  const totalPages = calculateTotalPages(totalCount, pageSize);

  if (page > totalPages && totalPages > 0) {
    return { ...queryParam, page: totalPages, total: totalCount };
  }

  return { ...queryParam, total: totalCount };
}

/**
 * Create a query parameter with pagination disabled.
 * @param queryParam - Optional base query parameters
 * @returns Query parameters with page and pageSize set to undefined
 */
export function noPaging(queryParam?: DynamicQueryParam): DynamicQueryParam {
  return {
    ...queryParam,
    page: undefined,
    pageSize: undefined,
  };
}

/**
 * Check whether the query parameters have pagination enabled.
 * @param queryParam - The query parameters to check
 * @returns True if both page and pageSize are defined
 */
export function isPaged(queryParam: DynamicQueryParam): boolean {
  return queryParam.page !== undefined && queryParam.pageSize !== undefined;
}

/**
 * Build a PaginatedResult from raw data and pagination metadata.
 * @param data - The data items for the current page
 * @param total - Total number of matching records
 * @param page - Current page number (1-based)
 * @param pageSize - Number of items per page
 * @returns A complete PaginatedResult
 */
export function toPaginatedResult<T>(
  data: T[],
  total: number,
  page: number,
  pageSize: number,
): PaginatedResult<T> {
  const safePage = Math.max(1, page);
  const safePageSize = Math.max(1, pageSize);
  return {
    data: data ?? [],
    total,
    page: safePage,
    pageSize: safePageSize,
    totalPages: calculateTotalPages(total, safePageSize),
    pageIndex: safePage - 1,
  };
}

/**
 * Calculate the total number of pages.
 * @param total - Total number of records
 * @param pageSize - Number of items per page
 * @returns The total number of pages
 */
export function calculateTotalPages(total: number, pageSize: number): number {
  if (pageSize <= 0) return 0;
  return Math.ceil(total / pageSize);
}
