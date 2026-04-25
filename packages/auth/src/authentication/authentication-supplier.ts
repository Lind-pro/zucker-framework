import type { Authentication } from '../interfaces';

/**
 * Authentication supplier interface.
 * Multiple suppliers can be registered to build a complete Authentication
 * from different sources (JWT, database, LDAP, etc.).
 *
 * Mirrors hsweb AuthenticationSupplier.
 */
export interface AuthenticationSupplier {
  /** Supplier priority — lower values are applied first */
  readonly order?: number;

  /**
   * Get authentication for the current request context.
   * Returns null if this supplier cannot provide authentication.
   */
  get(context: SupplierContext): Promise<Authentication | null>;

  /**
   * Get authentication for a specific user ID.
   * Used for admin impersonation or background jobs.
   */
  getByUserId?(userId: string): Promise<Authentication | null>;
}

export interface SupplierContext {
  /** The HTTP request object */
  request: {
    headers: Record<string, string | string[] | undefined>;
    user?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

export const AUTHENTICATION_SUPPLIERS = Symbol('AUTHENTICATION_SUPPLIERS');
