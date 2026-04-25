import { Injectable, NestMiddleware } from '@nestjs/common';
import { RequestContext } from './request-context';

const CORRELATION_ID_HEADER = 'x-correlation-id';
const TENANT_ID_HEADER = 'x-tenant-id';
const LOCALE_HEADER = 'accept-language';

/**
 * 统一请求上下文中间件
 *
 * 职责：
 * 1. 创建 RequestContext 并注入 AsyncLocalStorage
 * 2. 从请求头提取 correlationId / tenantId / locale
 * 3. 在响应头中回传 correlationId
 *
 * 替代旧的 CorrelationIdMiddleware，同时承载更多上下文。
 * 用户信息由 Guard 层设置（RequestContext.current().user = ...）。
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
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
    const correlationId =
      (req.headers[CORRELATION_ID_HEADER] as string) || undefined;
    const tenantId = req.headers[TENANT_ID_HEADER] as string | undefined;
    const locale = this.parseLocale(req.headers[LOCALE_HEADER] as string | undefined);

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
    const first = header.split(',')[0]?.trim();
    return first || 'zh-CN';
  }
}
