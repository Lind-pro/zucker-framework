export {
  TenantContext,
  getCurrentTenantId,
  setCurrentTenantId,
} from './tenant-context';

export { TenantInterceptor } from './tenant.interceptor';
export type {
  TenantResolveStrategy,
  TenantInterceptorOptions,
} from './tenant.interceptor';

export {
  RowLevelIsolation,
  SchemaLevelIsolation,
  TenantContextRequiredError,
} from './tenant-isolation';
export type { TenantIsolationStrategy, RowLevelIsolationOptions } from './tenant-isolation';
export {
  TenantResolver,
  isValidTenantId,
  DEFAULT_TENANT_ID_PATTERN,
  TENANT_MODULE_OPTIONS,
} from './tenant-resolver';
export type { VerifyTenantFn, TenantRequestLike } from './tenant-resolver';

export { TenantAware, SkipTenant, TENANT_AWARE_KEY, SKIP_TENANT_KEY } from './tenant.decorator';

export { TenantGuard } from './tenant.guard';

export { DataSourceLevelIsolation } from './tenant-datasource-isolation';
export type { TenantAsset, TenantAssetManager } from './tenant-datasource-isolation';

export {
  ZuckerTenantModule,
  TENANT_ISOLATION_STRATEGY,
} from './tenant.module';
export type { TenantModuleOptions, TenantModuleAsyncOptions, TenantModuleOptionsFactory } from './tenant.module';

export { TenantQuotaManager, TenantTemplateManager } from './tenant-quota';
export type { TenantQuota, QuotaUsage, QuotaCheckResult, TenantInitTemplate } from './tenant-quota';
