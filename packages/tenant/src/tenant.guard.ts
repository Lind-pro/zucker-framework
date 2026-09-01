import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { getCurrentTenantId } from './tenant-context';
import { TENANT_AWARE_KEY, SKIP_TENANT_KEY } from './tenant.decorator';

/**
 * 租户守卫 — 确保标记 @TenantAware 的路由必须有租户上下文
 *
 * 与拦截器不同，Guard 在请求进入 handler 前拦截，
 * 适用于「必须有租户上下文才能访问」的场景。
 *
 * 支持 @SkipTenant() 跳过检查。
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    /* 检查是否跳过 */
    const skipTenant = this.reflector.getAllAndOverride<boolean>(
      SKIP_TENANT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (skipTenant) return true;

    /* 检查是否需要租户 */
    const requireTenant = this.reflector.getAllAndOverride<boolean>(
      TENANT_AWARE_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requireTenant) {
      return true;
    }

    const tenantId = getCurrentTenantId();
    if (!tenantId) {
      throw new ForbiddenException(
        'Tenant context is required but not available',
      );
    }

    return true;
  }
}
