/**
 * 数据源异常类 — 对应 Java 端 DataSourceNotFoundException / DataSourceClosedException
 *
 * 对比 hsweb: DataSourceNotFoundException extends NotFoundException,
 *            DataSourceClosedException extends NotFoundException
 * zucker: 同样继承 BusinessException 子类，携带 dataSourceId 上下文
 */
import { NotFoundException, BusinessException } from '@zucker/core';

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
