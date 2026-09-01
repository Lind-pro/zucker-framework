import type { DataAccessConfig } from './data-access-config';
import type { DataAccessResult } from './data-access-result';
import type { Authentication } from '../interfaces';

/**
 * Context passed to DataAccessHandler for evaluation.
 */
export interface AuthorizingContext {
  /** Current authenticated user */
  authentication: Authentication;
  /** The permission being checked */
  permissionId: string;
  /** The action being performed (query/update/delete/etc.) */
  action: string;
  /** Data type / resource being accessed */
  dataType: string;
  /** HTTP request object (for accessing params, body, query) */
  request: {
    method: string;
    params: Record<string, string>;
    query: Record<string, unknown>;
    body: unknown;
    path: string;
    [key: string]: unknown;
  };
}

/**
 * Data access handler SPI.
 * Implementations handle specific DataAccessConfig types.
 * Registered via NestJS DI and iterated by DataPermissionGuard.
 */
export interface DataAccessHandler {
  /**
   * Whether this handler supports the given config.
   */
  isSupport(config: DataAccessConfig): boolean;

  /**
   * Evaluate data access for the given config and context.
   * Returns a result indicating allowed/denied + optional filter conditions.
   */
  handle(config: DataAccessConfig, context: AuthorizingContext): Promise<DataAccessResult>;
}

export const DATA_ACCESS_HANDLERS = Symbol('DATA_ACCESS_HANDLERS');
