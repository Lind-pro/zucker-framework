import { Inject, Injectable, NestMiddleware, Optional } from '@nestjs/common';
import { RequestContext } from './request-context';

const CORRELATION_ID_HEADER = 'x-correlation-id';
const TENANT_ID_HEADER = 'x-tenant-id';
const LOCALE_HEADER = 'accept-language';
/** Client-supplied correlation IDs are echoed and logged; accept only short, header-safe tokens. */
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_LOCALE = /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/;

export interface RequestContextMiddlewareOptions {
  /**
   * Populate `RequestContext.tenantId` from the unauthenticated `x-tenant-id` header.
   * Default `false`: the tenant must be set by the authentication layer
   * (`RequestContext.current().tenantId = ...`). Enable only behind a trusted proxy
   * that sets/overwrites this header.
   */
  trustTenantHeader?: boolean;
}

export const REQUEST_CONTEXT_MIDDLEWARE_OPTIONS = Symbol('REQUEST_CONTEXT_MIDDLEWARE_OPTIONS');

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * 统一请求上下文中间件
 *
 * 职责：
 * 1. 创建 RequestContext 并注入 AsyncLocalStorage
 * 2. 从请求头提取 correlationId / locale（tenantId 仅在 trustTenantHeader 时读取）
 * 3. 在响应头中回传 correlationId
 *
 * 替代旧的 CorrelationIdMiddleware，同时承载更多上下文。
 * 用户信息由 Guard 层设置（RequestContext.current().user = ...）。
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(
    @Optional()
    @Inject(REQUEST_CONTEXT_MIDDLEWARE_OPTIONS)
    private readonly options: RequestContextMiddlewareOptions = {},
  ) {}

  use(
    req: {
      headers: Record<string, string | string[] | undefined>;
      ip?: string;
      path?: string;
      method?: string;
    },
    res: { setHeader(name: string, value: string): void },
    next: () => void,
  ): void {
    const requestedId = firstHeader(req.headers[CORRELATION_ID_HEADER]);
    const correlationId =
      requestedId && SAFE_CORRELATION_ID.test(requestedId) ? requestedId : undefined;
    const tenantId = this.options?.trustTenantHeader
      ? firstHeader(req.headers[TENANT_ID_HEADER]) || undefined
      : undefined;
    const locale = this.parseLocale(firstHeader(req.headers[LOCALE_HEADER]));

    const ctx = new RequestContext({
      correlationId,
      tenantId,
      locale,
      ip: req.ip,
      path: req.path,
      method: req.method,
    });

    res.setHeader(CORRELATION_ID_HEADER, ctx.correlationId);

    RequestContext.run(ctx, () => {
      next();
    });
  }

  private parseLocale(header?: string): string {
    if (!header) return 'zh-CN';
    // Accept-Language: zh-CN,zh;q=0.9,en;q=0.8 → zh-CN
    const first = header.split(',')[0]?.split(';')[0]?.trim();
    return first && SAFE_LOCALE.test(first) ? first : 'zh-CN';
  }
}
