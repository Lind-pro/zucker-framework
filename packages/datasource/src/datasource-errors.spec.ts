import { describe, it, expect } from 'vitest';
import { DataSourceNotFoundException, DataSourceClosedException } from './datasource-errors';
import { NotFoundException, BusinessException } from '@zucker/core';

describe('DataSourceNotFoundException', () => {
  it('继承 NotFoundException', () => {
    const err = new DataSourceNotFoundException('db1');
    expect(err).toBeInstanceOf(NotFoundException);
  });

  it('默认消息包含数据源 ID', () => {
    const err = new DataSourceNotFoundException('db1');
    expect(err.message).toContain('db1');
  });

  it('携带 dataSourceId 属性', () => {
    const err = new DataSourceNotFoundException('my-ds');
    expect(err.dataSourceId).toBe('my-ds');
  });

  it('name 为 DataSourceNotFoundException', () => {
    const err = new DataSourceNotFoundException('x');
    expect(err.name).toBe('DataSourceNotFoundException');
  });

  it('支持自定义消息', () => {
    const err = new DataSourceNotFoundException('x', 'custom message');
    expect(err.message).toBe('custom message');
  });
});

describe('DataSourceClosedException', () => {
  it('继承 BusinessException', () => {
    const err = new DataSourceClosedException('db2');
    expect(err).toBeInstanceOf(BusinessException);
  });

  it('默认消息包含数据源 ID', () => {
    const err = new DataSourceClosedException('db2');
    expect(err.message).toContain('db2');
  });

  it('携带 dataSourceId 属性', () => {
    const err = new DataSourceClosedException('closed-ds');
    expect(err.dataSourceId).toBe('closed-ds');
  });

  it('name 为 DataSourceClosedException', () => {
    const err = new DataSourceClosedException('x');
    expect(err.name).toBe('DataSourceClosedException');
  });

  it('code 为 DATASOURCE_CLOSED', () => {
    const err = new DataSourceClosedException('x');
    expect(err.code).toBe('DATASOURCE_CLOSED');
  });
});
