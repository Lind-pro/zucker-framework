import { getCurrentTenantId } from './tenant-context';

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

  constructor(private readonly tenantField = 'tenantId') {}

  applyQueryFilter(where: Record<string, unknown>): Record<string, unknown> {
    const tenantId = getCurrentTenantId();
    if (!tenantId) return where;
    return { ...where, [this.tenantField]: tenantId };
  }

  applyCreateData(data: Record<string, unknown>): Record<string, unknown> {
    const tenantId = getCurrentTenantId();
    if (!tenantId) return data;
    return { ...data, [this.tenantField]: tenantId };
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
