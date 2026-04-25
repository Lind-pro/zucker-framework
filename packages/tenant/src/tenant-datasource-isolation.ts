import { getCurrentTenantId } from './tenant-context';
import { TenantIsolationStrategy } from './tenant-isolation';

/**
 * 数据源级隔离 — 按租户切换独立数据源
 *
 * 每个租户对应一个独立的数据源实例（独立数据库），
 * 通过 dataSourceResolver 将 tenantId 映射为 dataSourceId。
 */
export class DataSourceLevelIsolation implements TenantIsolationStrategy {
  readonly name = 'datasource-level';

  constructor(
    private readonly dataSourceResolver: (
      tenantId: string,
    ) => string | undefined,
  ) {}

  /**
   * 获取当前租户对应的数据源 ID
   */
  getDataSourceId(): string | undefined {
    const tenantId = getCurrentTenantId();
    if (!tenantId) return undefined;
    return this.dataSourceResolver(tenantId);
  }

  applyQueryFilter(where: Record<string, unknown>): Record<string, unknown> {
    // 数据源级隔离不需要修改查询条件
    return where;
  }

  applyCreateData(data: Record<string, unknown>): Record<string, unknown> {
    // 数据源级隔离不需要修改创建数据
    return data;
  }
}

/**
 * 租户资产信息 — 描述租户可访问的资源
 */
export interface TenantAsset {
  /** 租户 ID */
  tenantId: string;
  /** 资产类型 (如 menu, permission, datasource) */
  assetType: string;
  /** 资产 ID */
  assetId: string;
  /** 是否有权限 */
  granted: boolean;
}

/**
 * 租户资产管理器接口
 */
export interface TenantAssetManager {
  /**
   * 获取租户的某类资产
   */
  getAssets(tenantId: string, assetType: string): Promise<TenantAsset[]>;

  /**
   * 检查租户是否拥有某资产的权限
   */
  hasAsset(
    tenantId: string,
    assetType: string,
    assetId: string,
  ): Promise<boolean>;
}
