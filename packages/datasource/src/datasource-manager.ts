import { Injectable, Logger } from '@nestjs/common';
import { type ModelOperations, NotFoundException } from '@zucker/core';
import { DataSourceNotFoundException, DataSourceClosedException } from './datasource-errors';

export interface DataSourceConfig {
  id: string;
  name: string;
  type: string;
  url: string;
  options?: Record<string, unknown>;
}

export interface DatabaseAdapter {
  model(name: string): ModelOperations;
  $transaction<T>(fn: (adapter: DatabaseAdapter) => Promise<T>): Promise<T>;
}

export type DataSourceFactory = (config: DataSourceConfig) => Promise<DatabaseAdapter>;

/**
 * 数据源管理器 — 注册/获取/删除数据源，支持运行时动态添加
 *
 * 对应 Java 端 DynamicDataSourceService，提供数据源的生命周期管理。
 */
@Injectable()
export class DataSourceManager {
  private readonly logger = new Logger(DataSourceManager.name);
  private dataSources = new Map<string, DatabaseAdapter>();
  private configs = new Map<string, DataSourceConfig>();
  private factories = new Map<string, DataSourceFactory>();
  private closedSources = new Set<string>();
  private defaultId: string | null = null;

  /**
   * 注册数据源工厂（按 type）
   */
  registerFactory(type: string, factory: DataSourceFactory): void {
    this.factories.set(type, factory);
  }

  /**
   * 添加数据源配置并创建连接
   */
  async addDataSource(config: DataSourceConfig): Promise<void> {
    const factory = this.factories.get(config.type);
    if (!factory) {
      throw new NotFoundException(`No factory registered for datasource type: ${config.type}`);
    }

    const adapter = await factory(config);
    this.dataSources.set(config.id, adapter);
    this.configs.set(config.id, config);
    this.closedSources.delete(config.id);
    this.logger.log(`DataSource added: ${config.id} (${config.type})`);

    if (!this.defaultId) {
      this.defaultId = config.id;
    }
  }

  /**
   * 注册已创建的数据源
   */
  register(id: string, adapter: DatabaseAdapter, config?: DataSourceConfig): void {
    this.dataSources.set(id, adapter);
    if (config) this.configs.set(id, config);
    this.closedSources.delete(id);
    if (!this.defaultId) this.defaultId = id;
    this.logger.log(`DataSource registered: ${id}`);
  }

  /**
   * 获取数据源，不存在时抛出 DataSourceNotFoundException
   */
  getDataSource(id: string): DatabaseAdapter {
    if (this.closedSources.has(id)) {
      throw new DataSourceClosedException(id);
    }
    const ds = this.dataSources.get(id);
    if (!ds) {
      throw new DataSourceNotFoundException(id);
    }
    return ds;
  }

  /**
   * 获取默认数据源
   */
  getDefault(): DatabaseAdapter | undefined {
    return this.defaultId ? this.dataSources.get(this.defaultId) : undefined;
  }

  /** 获取默认数据源 ID */
  getDefaultId(): string | null {
    return this.defaultId;
  }

  setDefault(id: string): void {
    if (!this.dataSources.has(id)) {
      throw new DataSourceNotFoundException(id);
    }
    this.defaultId = id;
  }

  /**
   * 删除数据源
   */
  remove(id: string): void {
    this.dataSources.delete(id);
    this.configs.delete(id);
    this.closedSources.delete(id);
    if (this.defaultId === id) {
      this.defaultId = this.dataSources.size > 0
        ? this.dataSources.keys().next().value ?? null
        : null;
    }
    this.logger.log(`DataSource removed: ${id}`);
  }

  /**
   * 关闭数据源（标记为已关闭但保留配置）
   */
  close(id: string): void {
    if (!this.dataSources.has(id)) {
      throw new DataSourceNotFoundException(id);
    }
    this.dataSources.delete(id);
    this.closedSources.add(id);
    this.logger.log(`DataSource closed: ${id}`);
  }

  /**
   * 判断数据源是否已关闭
   */
  isClosed(id: string): boolean {
    return this.closedSources.has(id);
  }

  /**
   * 获取所有数据源配置
   */
  getConfigs(): DataSourceConfig[] {
    return Array.from(this.configs.values());
  }

  /**
   * 判断数据源是否存在
   */
  has(id: string): boolean {
    return this.dataSources.has(id);
  }

  /**
   * 安全判断数据源是否存在（不抛异常）
   */
  existing(id: string): boolean {
    try {
      return this.getDataSource(id) != null;
    } catch {
      return false;
    }
  }

  /**
   * 重新加载数据源：先关闭旧的，再根据保存的配置重新创建
   * 对齐 Java DynamicDataSourceService.reload(id)
   * @param id 数据源 ID
   */
  async reload(id: string): Promise<void> {
    const config = this.configs.get(id);
    if (!config) {
      throw new DataSourceNotFoundException(id);
    }

    // 关闭旧数据源（如果存在）
    if (this.dataSources.has(id)) {
      this.dataSources.delete(id);
    }
    this.closedSources.delete(id);

    // 重新创建
    const factory = this.factories.get(config.type);
    if (!factory) {
      throw new NotFoundException(`No factory registered for datasource type: ${config.type}`);
    }

    const adapter = await factory(config);
    this.dataSources.set(id, adapter);
    this.logger.log(`DataSource reloaded: ${id}`);
  }
}
