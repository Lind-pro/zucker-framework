/**
 * Standard API response envelope.
 * All API endpoints return data wrapped in this structure.
 *
 * @template T - The type of the response payload
 */
export interface ApiResponse<T> {
  /** HTTP status code */
  status: number;
  /** Human-readable message */
  message: string;
  /** Response payload */
  result: T;
  /** Response timestamp in milliseconds */
  timestamp: number;
}

/**
 * Paginated query result.
 *
 * @template T - The type of each data item
 *
 * @example
 * ```ts
 * const result: PaginatedResult<User> = {
 *   data: [user1, user2],
 *   total: 100,
 *   page: 1,
 *   pageSize: 10,
 *   totalPages: 10,
 * };
 * ```
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
}

/**
 * Generic query parameter structure for database queries.
 */
export interface QueryParam {
  /** Page number (1-based) */
  page?: number;
  /** Number of items per page */
  pageSize?: number;
  /** Filter conditions */
  where?: Record<string, unknown>;
  /** Sort order specification */
  orderBy?: Record<string, 'asc' | 'desc'> | Array<Record<string, 'asc' | 'desc'>>;
  /** Fields to include in the result */
  includes?: string[];
  /** Fields to exclude from the result */
  excludes?: string[];
}

/**
 * Query term — represents a single filter condition.
 * Supports nested terms for complex boolean expressions.
 */
export interface Term {
  /** Column/field name to filter on */
  column: string;
  /** Filter operator type (e.g., 'eq', 'like', 'gt') */
  termType: string;
  /** Filter value */
  value: unknown;
  /** Boolean connector for chaining terms */
  type?: 'and' | 'or';
  /** Nested sub-terms for grouped conditions */
  terms?: Term[];
}
