/**
 * 数据源异常类，携带 dataSourceId 上下文。
 * 数据源不存在时返回 404，已关闭时返回 500。
 */
import { NotFoundException, BusinessException } from '@zucker-framework/core';

/**
 * 数据源不存在异常 (HTTP 404)
 */
export class DataSourceNotFoundException extends NotFoundException {
  readonly dataSourceId: string;

  constructor(dataSourceId: string, message?: string) {
    super(message ?? `DataSource not found: ${dataSourceId}`);
    this.name = 'DataSourceNotFoundException';
    this.dataSourceId = dataSourceId;
  }
}

/**
 * 数据源已关闭异常 (HTTP 500)
 */
export class DataSourceClosedException extends BusinessException {
  readonly dataSourceId: string;

  constructor(dataSourceId: string, message?: string) {
    super(message ?? `DataSource closed: ${dataSourceId}`, 'DATASOURCE_CLOSED', 500);
    this.name = 'DataSourceClosedException';
    this.dataSourceId = dataSourceId;
  }
}
