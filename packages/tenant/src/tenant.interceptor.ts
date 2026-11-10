import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable, type Subscription } from 'rxjs';
import { BusinessException } from '@zucker-framework/core';
import { TenantContext } from './tenant-context';
import { TenantResolver, type TenantInterceptorOptions } from './tenant-resolver';

export type { TenantResolveStrategy, TenantInterceptorOptions } from './tenant-resolver';

/**
 * NestJS 拦截器 — 从请求中提取、校验租户 ID 并绑定 TenantContext。
 *
 * The default strategy is `jwt`. `header` / `subdomain` require `verifyTenant` (membership
 * check) or an explicit `trustClientTenant: true`; malformed IDs are rejected with 400.
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  private readonly resolver: TenantResolver;

  constructor(options?: TenantInterceptorOptions) {
    this.resolver = new TenantResolver(options);
  }

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest();
    const tenantId = await this.resolver.resolve(request);

    if (this.resolver.options.required && !tenantId) {
      throw new BusinessException('Tenant ID is required but not provided', 'TENANT_REQUIRED', 400);
    }

    if (!tenantId) {
      return next.handle();
    }

    return new Observable((subscriber) => {
      let inner: Subscription | undefined;
      // Subscribing inside the ALS scope runs the handler (and its async continuations) in it.
      TenantContext.runWithTenant(tenantId, () => {
        inner = next.handle().subscribe(subscriber);
      });
      return () => inner?.unsubscribe();
    });
  }
}
