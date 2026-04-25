import { SetMetadata } from '@nestjs/common';

export const TENANT_AWARE_KEY = 'zucker:tenant:aware';
export const SKIP_TENANT_KEY = 'zucker:tenant:skip';

/**
 * @TenantAware 装饰器 — 标记类/方法需要租户隔离
 *
 * 应用于类时，该类下的所有路由都需要租户上下文；
 * 应用于方法时，仅该方法需要租户上下文。
 *
 * 配合 TenantGuard 使用，缺少租户上下文时返回 403。
 */
export const TenantAware = (): ClassDecorator & MethodDecorator => {
  return SetMetadata(TENANT_AWARE_KEY, true);
};

/**
 * @SkipTenant 方法装饰器 — 跳过租户检查
 *
 * 在类级别使用 @TenantAware 时，若某些方法不需要
 * 租户上下文（如公共 API），可使用此装饰器跳过。
 */
export const SkipTenant = (): MethodDecorator => {
  return SetMetadata(SKIP_TENANT_KEY, true);
};
