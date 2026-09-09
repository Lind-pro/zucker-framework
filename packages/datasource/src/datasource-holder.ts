import { AsyncLocalStorage } from 'async_hooks';
import { BusinessException } from '@zucker-framework/core';
import { DataSourceManager, DatabaseAdapter } from './datasource-manager';
import { DataSourceNotFoundException } from './datasource-errors';

const dataSourceStorage = new AsyncLocalStorage<string>();

/**
 * 获取当前绑定的数据源 ID
 */
export function getCurrentDataSourceId(): string | undefined {
  return dataSourceStorage.getStore();
}

/**
 * 数据源持有者 — 对应 Java 端 DataSourceHolder
 *
 * 通过 AsyncLocalStorage 绑定当前数据源，并提供
 * 丰富的查询方法（currentIsDefault / existing / currentExisting 等）。
 */
export class DataSourceHolder {
  constructor(private readonly manager: DataSourceManager) {}

  /**
   * 在指定数据源上执行操作
   */
  async useDataSource<T>(id: string, fn: (adapter: DatabaseAdapter) => Promise<T>): Promise<T> {
    const adapter = this.manager.getDataSource(id);
    return dataSourceStorage.run(id, () => fn(adapter));
  }

  /**
   * 获取当前上下文绑定的数据源
   */
  getCurrent(): DatabaseAdapter | undefined {
    const id = getCurrentDataSourceId();
    if (!id) return this.manager.getDefault();
    return this.manager.getDataSource(id);
  }

  /**
   * 获取默认数据源
   */
  getDefault(): DatabaseAdapter | undefined {
    return this.manager.getDefault();
  }

  /**
   * 根据 ID 获取数据源
   */
  getDataSource(id: string): DatabaseAdapter {
    return this.manager.getDataSource(id);
  }

  /**
   * 当前是否使用默认数据源
   */
  currentIsDefault(): boolean {
    return getCurrentDataSourceId() === undefined;
  }

  /**
   * 判断指定 ID 的数据源是否存在（不抛异常）
   */
  existing(id: string): boolean {
    return this.manager.existing(id);
  }

  /**
   * 当前数据源是否存在（不抛异常）
   */
  currentExisting(): boolean {
    if (this.currentIsDefault()) return true;
    try {
      return this.getCurrent() != null;
    } catch (e) {
      if (e instanceof DataSourceNotFoundException) return false;
      throw e;
    }
  }

  /**
   * 服务是否就绪
   */
  isReady(): boolean {
    return this.manager.getDefault() !== undefined;
  }

  /**
   * 检查服务就绪，不就绪则抛异常
   */
  checkReady(): void {
    if (!this.isReady()) {
      throw new BusinessException('DataSourceService not ready', 'DATASOURCE_NOT_READY', 503);
    }
  }

  /**
   * 判断当前上下文是否使用了动态（非默认）数据源
   * 对齐 Java DataSourceHolder.isDynamic()
   */
  isDynamic(): boolean {
    return getCurrentDataSourceId() !== undefined;
  }
}
