import { ForbiddenException } from '@nestjs/common';
import { BusinessException } from '@zucker-framework/core';

export type TenantResolveStrategy = 'header' | 'jwt' | 'subdomain';

/** Request shape the resolver reads. Header values may be arrays for repeated headers. */
export interface TenantRequestLike {
  headers?: Record<string, string | string[] | undefined>;
  user?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Decide whether the request may act for `tenantId`, typically by checking that the
 * authenticated user is a member of the tenant. Called for every resolved tenant ID.
 */
export type VerifyTenantFn = (
  tenantId: string,
  request: TenantRequestLike,
) => boolean | Promise<boolean>;

export interface TenantInterceptorOptions {
  /**
   * 租户解析策略，默认 `jwt` (tenant taken from the authenticated `request.user`).
   * `header` and `subdomain` read client-controlled input and therefore require
   * `verifyTenant` (or an explicit `trustClientTenant: true`).
   */
  strategy?: TenantResolveStrategy;
  /** Header 名称，默认 X-Tenant-ID */
  headerName?: string;
  /** JWT 中的租户字段名，默认 tenantId */
  jwtField?: string;
  /** 是否必填，默认 false */
  required?: boolean;
  /** Membership check applied to every resolved tenant ID (all strategies). */
  verifyTenant?: VerifyTenantFn;
  /**
   * Accept `header` / `subdomain` tenant IDs without `verifyTenant`. Only safe when a
   * trusted upstream (gateway) sets or validates the value. Defaults to false.
   */
  trustClientTenant?: boolean;
  /** Allowed tenant ID format. Defaults to `/^[A-Za-z0-9_-]{1,64}$/`. */
  tenantIdPattern?: RegExp;
}

export const DEFAULT_TENANT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const TENANT_MODULE_OPTIONS = Symbol('TENANT_MODULE_OPTIONS');
/** Request property holding the tenant ID resolved by `TenantGuard`, reused by the interceptor. */
export const RESOLVED_TENANT_KEY = '__zuckerResolvedTenant';

export function isValidTenantId(value: unknown, pattern: RegExp = DEFAULT_TENANT_ID_PATTERN): value is string {
  return typeof value === 'string' && pattern.test(value);
}

/** Resolves, validates and verifies the tenant for a request. Shared by guard and interceptor. */
export class TenantResolver {
  readonly options: Required<Omit<TenantInterceptorOptions, 'verifyTenant'>> &
    Pick<TenantInterceptorOptions, 'verifyTenant'>;

  constructor(options?: TenantInterceptorOptions) {
    this.options = {
      strategy: options?.strategy ?? 'jwt',
      headerName: (options?.headerName ?? 'x-tenant-id').toLowerCase(),
      jwtField: options?.jwtField ?? 'tenantId',
      required: options?.required ?? false,
      verifyTenant: options?.verifyTenant,
      trustClientTenant: options?.trustClientTenant ?? false,
      tenantIdPattern: options?.tenantIdPattern ?? DEFAULT_TENANT_ID_PATTERN,
    };
    if (this.options.strategy !== 'jwt' && !this.options.verifyTenant && !this.options.trustClientTenant) {
      throw new Error(
        `Tenant strategy '${this.options.strategy}' reads a client-controlled value; ` +
        'configure verifyTenant(tenantId, request) or set trustClientTenant: true',
      );
    }
  }

  /**
   * @returns the verified tenant ID, or undefined when the request carries none.
   * @throws 400 for malformed values, 403 when `verifyTenant` rejects.
   */
  async resolve(request: TenantRequestLike): Promise<string | undefined> {
    if (Object.prototype.hasOwnProperty.call(request, RESOLVED_TENANT_KEY)) {
      return request[RESOLVED_TENANT_KEY] as string | undefined;
    }
    const raw = this.extract(request);
    let tenantId: string | undefined;
    if (raw !== undefined) {
      if (!isValidTenantId(raw, this.options.tenantIdPattern)) {
        throw new BusinessException('Invalid tenant ID', 'TENANT_INVALID', 400);
      }
      if (this.options.verifyTenant && !(await this.options.verifyTenant(raw, request))) {
        throw new ForbiddenException('Tenant access denied');
      }
      tenantId = raw;
    }
    Object.defineProperty(request, RESOLVED_TENANT_KEY, {
      value: tenantId, enumerable: false, configurable: true,
    });
    return tenantId;
  }

  /** Raw candidate: undefined when absent; arrays and non-strings fail validation later. */
  private extract(request: TenantRequestLike): unknown {
    switch (this.options.strategy) {
      case 'header': {
        const value = request.headers?.[this.options.headerName];
        return value === '' ? undefined : value;
      }
      case 'jwt': {
        const value = request.user?.[this.options.jwtField];
        if (value === undefined || value === null || value === '') return undefined;
        return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
      }
      case 'subdomain': {
        const host = request.headers?.host;
        if (typeof host !== 'string') return host;
        const parts = host.replace(/:\d+$/, '').split('.');
        return parts.length > 2 ? parts[0] : undefined;
      }
      default:
        return undefined;
    }
  }
}
