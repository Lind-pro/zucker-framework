import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { getCurrentTenantId } from './tenant-context';
import { TENANT_AWARE_KEY, SKIP_TENANT_KEY } from './tenant.decorator';
import { TENANT_MODULE_OPTIONS, TenantResolver, type TenantInterceptorOptions } from './tenant-resolver';

/**
 * 租户守卫 — 确保标记 @TenantAware 的路由必须有租户上下文
 *
 * Guards run before interceptors, so the guard resolves (validates and verifies) the
 * tenant itself with the module's options instead of reading the interceptor's context.
 * The result is cached on the request and reused by `TenantInterceptor`.
 * With the `jwt` strategy, authentication must run before this guard.
 *
 * 支持 @SkipTenant() 跳过检查。
 */
@Injectable()
export class TenantGuard implements CanActivate {
  private readonly resolver: TenantResolver;

  constructor(
    private readonly reflector: Reflector,
    @Optional() @Inject(TENANT_MODULE_OPTIONS) options?: TenantInterceptorOptions,
  ) {
    this.resolver = new TenantResolver(options);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(SKIP_TENANT_KEY, targets)) return true;
    if (!this.reflector.getAllAndOverride<boolean>(TENANT_AWARE_KEY, targets)) return true;

    if (getCurrentTenantId()) return true;
    const tenantId = await this.resolver.resolve(context.switchToHttp().getRequest());
    if (!tenantId) {
      throw new ForbiddenException('Tenant context is required but not available');
    }
    return true;
  }
}
