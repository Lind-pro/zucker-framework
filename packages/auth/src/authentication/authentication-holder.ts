import { Injectable, Inject, Optional, Logger } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Authentication } from '../interfaces';
import type { AuthenticationSupplier, SupplierContext } from './authentication-supplier';
import { AUTHENTICATION_SUPPLIERS } from './authentication-supplier';
import { DefaultAuthentication } from './default-authentication';

/**
 * AuthenticationHolder — resolves and caches Authentication per request.
 *
 * Aggregates multiple AuthenticationSuppliers (JWT, database, LDAP, etc.)
 * and merges their results into a single Authentication instance.
 *
 * Uses AsyncLocalStorage for request-scoped caching so that
 * the same request only resolves suppliers once.
 *
 * Mirrors hsweb AuthenticationHolder.
 */
@Injectable()
export class AuthenticationHolder {
  private readonly logger = new Logger(AuthenticationHolder.name);
  private readonly als = new AsyncLocalStorage<Map<string, Authentication>>();

  private readonly suppliers: AuthenticationSupplier[];

  constructor(
    @Optional()
    @Inject(AUTHENTICATION_SUPPLIERS)
    suppliers: AuthenticationSupplier[] | null,
  ) {
    // Sort by order (lower first)
    this.suppliers = (suppliers || []).slice().sort(
      (a, b) => (a.order ?? 100) - (b.order ?? 100),
    );
    if (this.suppliers.length > 0) {
      this.logger.log(
        `已注册 ${this.suppliers.length} 个 AuthenticationSupplier`,
      );
    }
  }

  /**
   * Run a function within an AsyncLocalStorage context.
   * Call this in middleware or interceptor to enable request-level caching.
   */
  runInContext<T>(fn: () => T): T {
    return this.als.run(new Map(), fn);
  }

  /**
   * Resolve the current Authentication from all registered suppliers.
   * Results are cached per-request via AsyncLocalStorage.
   */
  async resolve(context: SupplierContext): Promise<Authentication | null> {
    // Check ALS cache first
    const store = this.als.getStore();
    const cacheKey = 'current';
    if (store?.has(cacheKey)) {
      return store.get(cacheKey)!;
    }

    if (this.suppliers.length === 0) {
      return null;
    }

    // Single supplier: no merge needed
    if (this.suppliers.length === 1) {
      const auth = await this.suppliers[0].get(context);
      if (auth && store) {
        store.set(cacheKey, auth);
      }
      return auth;
    }

    // Multiple suppliers: merge all results
    const merged = new DefaultAuthentication();
    let hasAny = false;

    for (const supplier of this.suppliers) {
      try {
        const auth = await supplier.get(context);
        if (auth) {
          merged.merge(auth);
          hasAny = true;
        }
      } catch (error) {
        this.logger.warn(`AuthenticationSupplier failed: ${error}`);
      }
    }

    if (!hasAny || !merged.getUser().id) {
      return null;
    }

    if (store) {
      store.set(cacheKey, merged);
    }

    return merged;
  }

  /**
   * Resolve Authentication by user ID (for background jobs, impersonation).
   */
  async resolveByUserId(userId: string): Promise<Authentication | null> {
    const merged = new DefaultAuthentication();
    let hasAny = false;

    for (const supplier of this.suppliers) {
      if (!supplier.getByUserId) continue;
      try {
        const auth = await supplier.getByUserId(userId);
        if (auth) {
          merged.merge(auth);
          hasAny = true;
        }
      } catch (error) {
        this.logger.warn(`AuthenticationSupplier.getByUserId failed: ${error}`);
      }
    }

    return hasAny && merged.getUser().id ? merged : null;
  }

  /**
   * Get the current Authentication from ALS cache without re-resolving.
   */
  getCurrent(): Authentication | null {
    const store = this.als.getStore();
    return store?.get('current') ?? null;
  }
}
