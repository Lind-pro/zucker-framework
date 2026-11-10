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
import {
  TENANT_MODULE_OPTIONS,
  TENANT_REQUIRED_KEY,
  TenantResolver,
  type TenantInterceptorOptions,
} from './tenant-resolver';

/**
 * 租户守卫 — 确保标记 @TenantAware 的路由必须有租户上下文
 *
 * Guards run before interceptors, so the guard resolves (validates and verifies) the
 * tenant itself with the module's options instead of reading the interceptor's context.
 * The result is cached on the request and reused by `TenantInterceptor`.
 *
 * Ordering: a global guard runs before controller-level guards. When the tenant depends on
 * `request.user` (`jwt` strategy, or a `verifyTenant` callback) and no user is set yet, the guard
 * does not decide: it marks the request and `TenantInterceptor` (which runs after all guards)
 * enforces the tenant requirement with 403.
 *
 * 支持 @SkipTenant() 跳过检查。
 */
@Injectable()
export class TenantGuard implements CanActivate {
  private resolverInstance?: TenantResolver;

  constructor(
    private readonly reflector: Reflector,
    @Optional() @Inject(TENANT_MODULE_OPTIONS) private readonly options?: TenantInterceptorOptions,
  ) {}

  /** Built on first use, so a guard that is registered but never enabled cannot fail startup. */
  private get resolver(): TenantResolver {
    return (this.resolverInstance ??= new TenantResolver(this.options));
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(SKIP_TENANT_KEY, targets)) return true;
    if (!this.reflector.getAllAndOverride<boolean>(TENANT_AWARE_KEY, targets)) return true;

    if (getCurrentTenantId()) return true;
    const request = context.switchToHttp().getRequest();
    const dependsOnUser = this.resolver.options.strategy === 'jwt' || !!this.resolver.options.verifyTenant;
    if (dependsOnUser && !request.user) {
      // Authentication has not run yet (controller-level guard). Resolving now would cache
      // "no tenant" on the request; defer the decision to the interceptor.
      Object.defineProperty(request, TENANT_REQUIRED_KEY, { value: true, enumerable: false, configurable: true });
      return true;
    }
    const tenantId = await this.resolver.resolve(request);
    if (!tenantId) {
      throw new ForbiddenException('Tenant context is required but not available');
    }
    return true;
  }
}
