import { DatabaseType } from './database-type';

/**
 * 动态数据源配置 — 对应 Java 端 DynamicDataSourceConfig
 */
export interface DynamicDataSourceConfig {
  /** 数据源唯一 ID */
  id: string;
  /** 显示名称 */
  name: string;
  /** 描述 */
  describe?: string;
  /** 数据库类型 */
  databaseType?: DatabaseType;
  /** 连接 URL */
  url?: string;
  /** 扩展选项 */
  options?: Record<string, unknown>;
}

/**
 * 数据源配置仓库接口 — 对应 Java 端 DynamicDataSourceConfigRepository
 *
 * 提供数据源配置的 CRUD 操作，可由不同存储后端实现
 * （内存、数据库、远程配置中心等）。
 */
export interface DynamicDataSourceConfigRepository<
  C extends DynamicDataSourceConfig = DynamicDataSourceConfig,
> {
  findAll(): Promise<C[]>;
  findById(dataSourceId: string): Promise<C | undefined>;
  add(config: C): Promise<C>;
  remove(dataSourceId: string): Promise<C | undefined>;
}

/**
 * 内存配置仓库 — 默认实现，适用于开发和测试
 */
export class InMemoryDataSourceConfigRepository
  implements DynamicDataSourceConfigRepository
{
  private readonly configs = new Map<string, DynamicDataSourceConfig>();

  async findAll(): Promise<DynamicDataSourceConfig[]> {
    return Array.from(this.configs.values());
  }

  async findById(
    dataSourceId: string,
  ): Promise<DynamicDataSourceConfig | undefined> {
    return this.configs.get(dataSourceId);
  }

  async add(
    config: DynamicDataSourceConfig,
  ): Promise<DynamicDataSourceConfig> {
    this.configs.set(config.id, config);
    return config;
  }

  async remove(
    dataSourceId: string,
  ): Promise<DynamicDataSourceConfig | undefined> {
    const config = this.configs.get(dataSourceId);
    this.configs.delete(dataSourceId);
    return config;
  }
}
