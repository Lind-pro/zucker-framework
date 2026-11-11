import { TenantContext, getCurrentTenantId } from './tenant-context';
import { DEFAULT_TENANT_ID_PATTERN } from './tenant-resolver';

/** Thrown when tenant-scoped data access runs without a tenant context (fail closed). */
export class TenantContextRequiredError extends Error {
  readonly code = 'TENANT_CONTEXT_REQUIRED';
  constructor(operation: string) {
    super(`Tenant context is required for ${operation}; use TenantContext.runWithoutTenantIsolation() for system access`);
    this.name = 'TenantContextRequiredError';
  }
}

export interface RowLevelIsolationOptions {
  /**
   * Restore the pre-1.0.20 fail-open behaviour: without a tenant context, queries are not
   * filtered and created rows get no tenant. Defaults to false (throw).
   */
  allowMissingTenant?: boolean;
}

/**
 * 租户隔离策略接口
 */
export interface TenantIsolationStrategy {
  /** 策略名称 */
  readonly name: string;

  /**
   * 为查询条件注入租户过滤
   */
  applyQueryFilter(where: Record<string, unknown>): Record<string, unknown>;

  /**
   * 为创建数据注入租户字段
   */
  applyCreateData(data: Record<string, unknown>): Record<string, unknown>;
}

/**
 * 行级隔离 — 自动注入 tenantId 到查询条件和创建数据
 */
export class RowLevelIsolation implements TenantIsolationStrategy {
  readonly name = 'row-level';

  constructor(
    private readonly tenantField = 'tenantId',
    private readonly options: RowLevelIsolationOptions = {},
  ) {}

  applyQueryFilter(where: Record<string, unknown>): Record<string, unknown> {
    const tenantId = this.requireTenant('query');
    if (!tenantId) return where;
    return { ...where, [this.tenantField]: tenantId };
  }

  applyCreateData(data: Record<string, unknown>): Record<string, unknown> {
    const tenantId = this.requireTenant('create');
    if (!tenantId) return data;
    return { ...data, [this.tenantField]: tenantId };
  }

  private requireTenant(operation: string): string | undefined {
    const tenantId = getCurrentTenantId();
    if (tenantId) return tenantId;
    if (this.options.allowMissingTenant || TenantContext.isTenantIsolationBypassed()) return undefined;
    throw new TenantContextRequiredError(operation);
  }
}

/**
 * Schema 级隔离 — 按租户切换 schema
 */
export class SchemaLevelIsolation implements TenantIsolationStrategy {
  readonly name = 'schema-level';

  constructor(private readonly schemaPrefix = 'tenant_') {}

  /**
   * 获取当前租户的 schema 名称
   */
  getSchemaName(): string | undefined {
    const tenantId = getCurrentTenantId();
    if (!tenantId) return undefined;
    // Schema names cannot be bound parameters; never build one from an unvalidated ID.
    // Still quote the identifier when interpolating it into SQL.
    if (!DEFAULT_TENANT_ID_PATTERN.test(tenantId)) {
      throw new Error('Tenant ID is not a valid schema name component');
    }
    return `${this.schemaPrefix}${tenantId}`;
  }

  applyQueryFilter(where: Record<string, unknown>): Record<string, unknown> {
    // Schema 隔离不需要修改查询条件
    return where;
  }

  applyCreateData(data: Record<string, unknown>): Record<string, unknown> {
    // Schema 隔离不需要修改创建数据
    return data;
  }
}
