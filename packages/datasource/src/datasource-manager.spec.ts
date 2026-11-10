import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DataSourceManager,
  type DatabaseAdapter,
  type DataSourceConfig,
} from './datasource-manager';
import { DataSourceNotFoundException, DataSourceClosedException } from './datasource-errors';

function makeAdapter(): DatabaseAdapter {
  return {
    model: vi.fn(),
    $transaction: vi.fn(),
  };
}

function makeConfig(id: string, type = 'mock'): DataSourceConfig {
  return { id, name: `DS-${id}`, type, url: `mock://localhost/${id}` };
}

describe('DataSourceManager', () => {
  let manager: DataSourceManager;

  beforeEach(() => {
    manager = new DataSourceManager();
  });

  // ---------- registerFactory + addDataSource ----------

  it('registerFactory 注册工厂后 addDataSource 调用工厂创建 adapter', async () => {
    const adapter = makeAdapter();
    const factory = vi.fn().mockResolvedValue(adapter);
    manager.registerFactory('mock', factory);

    await manager.addDataSource(makeConfig('ds1'));

    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ id: 'ds1', type: 'mock' }));
  });

  it('addDataSource 后 getDataSource(id) 返回对应 adapter', async () => {
    const adapter = makeAdapter();
    manager.registerFactory('mock', vi.fn().mockResolvedValue(adapter));
    await manager.addDataSource(makeConfig('ds1'));

    expect(manager.getDataSource('ds1')).toBe(adapter);
  });

  it('addDataSource 未注册工厂时抛出 NotFoundException', async () => {
    await expect(manager.addDataSource(makeConfig('ds1', 'unknown'))).rejects.toThrow(
      'No factory registered for datasource type: unknown',
    );
  });

  // ---------- register（直接注册 adapter）----------

  it('register() 直接注册 adapter，getDataSource 可返回', () => {
    const adapter = makeAdapter();
    manager.register('ds1', adapter, makeConfig('ds1'));
    expect(manager.getDataSource('ds1')).toBe(adapter);
  });

  // ---------- getDataSource 异常路径 ----------

  it('getDataSource(不存在) 抛 DataSourceNotFoundException', () => {
    expect(() => manager.getDataSource('ghost')).toThrow(DataSourceNotFoundException);
  });

  it('DataSourceNotFoundException 携带正确的 dataSourceId', () => {
    try {
      manager.getDataSource('ghost');
    } catch (e) {
      expect(e).toBeInstanceOf(DataSourceNotFoundException);
      expect((e as DataSourceNotFoundException).dataSourceId).toBe('ghost');
    }
  });

  // ---------- close + 已关闭时 get 抛异常 ----------

  it('close(id) 后 getDataSource(id) 抛 DataSourceClosedException', () => {
    const adapter = makeAdapter();
    manager.register('ds1', adapter);
    manager.close('ds1');

    expect(() => manager.getDataSource('ds1')).toThrow(DataSourceClosedException);
  });

  it('isClosed(id) 在 close 后返回 true', () => {
    manager.register('ds1', makeAdapter());
    manager.close('ds1');
    expect(manager.isClosed('ds1')).toBe(true);
  });

  it('close(不存在) 抛 DataSourceNotFoundException', () => {
    expect(() => manager.close('ghost')).toThrow(DataSourceNotFoundException);
  });

  // ---------- remove ----------

  it('remove(id) 后 has(id) 返回 false', () => {
    manager.register('ds1', makeAdapter());
    manager.remove('ds1');
    expect(manager.has('ds1')).toBe(false);
  });

  it('remove(id) 后 getDataSource(id) 抛 DataSourceNotFoundException（非 Closed）', () => {
    manager.register('ds1', makeAdapter());
    manager.remove('ds1');

    expect(() => manager.getDataSource('ds1')).toThrow(DataSourceNotFoundException);
  });

  // ---------- setDefault / getDefault ----------

  it('第一次 addDataSource 自动设为默认数据源', async () => {
    const adapter = makeAdapter();
    manager.registerFactory('mock', vi.fn().mockResolvedValue(adapter));
    await manager.addDataSource(makeConfig('first'));

    expect(manager.getDefault()).toBe(adapter);
    expect(manager.getDefaultId()).toBe('first');
  });

  it('setDefault(id) 切换默认数据源', () => {
    const a1 = makeAdapter();
    const a2 = makeAdapter();
    manager.register('ds1', a1);
    manager.register('ds2', a2);
    manager.setDefault('ds2');

    expect(manager.getDefault()).toBe(a2);
    expect(manager.getDefaultId()).toBe('ds2');
  });

  it('setDefault(不存在) 抛 DataSourceNotFoundException', () => {
    expect(() => manager.setDefault('ghost')).toThrow(DataSourceNotFoundException);
  });

  // ---------- has / existing ----------

  it('has(id) 对已注册数据源返回 true', () => {
    manager.register('ds1', makeAdapter());
    expect(manager.has('ds1')).toBe(true);
  });

  it('existing(id) 对已注册数据源返回 true，对不存在的返回 false', () => {
    manager.register('ds1', makeAdapter());
    expect(manager.existing('ds1')).toBe(true);
    expect(manager.existing('ghost')).toBe(false);
  });

  it('existing(id) 对已关闭数据源返回 false', () => {
    manager.register('ds1', makeAdapter());
    manager.close('ds1');
    expect(manager.existing('ds1')).toBe(false);
  });

  // ---------- getConfigs ----------

  it('getConfigs() 返回所有已注册的配置', async () => {
    manager.registerFactory('mock', vi.fn().mockResolvedValue(makeAdapter()));
    await manager.addDataSource(makeConfig('ds1'));
    await manager.addDataSource(makeConfig('ds2'));

    const configs = manager.getConfigs();
    expect(configs).toHaveLength(2);
    expect(configs.map((c) => c.id)).toEqual(expect.arrayContaining(['ds1', 'ds2']));
  });

  // ---------- reload ----------

  it('reload(id) 重新调用工厂创建新的 adapter', async () => {
    const adapterV1 = makeAdapter();
    const adapterV2 = makeAdapter();
    const factory = vi.fn().mockResolvedValueOnce(adapterV1).mockResolvedValueOnce(adapterV2);
    manager.registerFactory('mock', factory);
    await manager.addDataSource(makeConfig('ds1'));

    await manager.reload('ds1');

    expect(factory).toHaveBeenCalledTimes(2);
    expect(manager.getDataSource('ds1')).toBe(adapterV2);
  });

  it('reload(不存在) 抛 DataSourceNotFoundException', async () => {
    await expect(manager.reload('ghost')).rejects.toThrow(DataSourceNotFoundException);
  });

  // ---------- regressions (review M11) ----------

  it('reload 工厂失败时保留旧 adapter 可用', async () => {
    const adapterV1 = makeAdapter();
    const factory = vi.fn().mockResolvedValueOnce(adapterV1).mockRejectedValueOnce(new Error('db down'));
    manager.registerFactory('mock', factory);
    await manager.addDataSource(makeConfig('ds1'));

    await expect(manager.reload('ds1')).rejects.toThrow('db down');
    expect(manager.getDataSource('ds1')).toBe(adapterV1);
  });

  it('reload/remove/close 会释放被替换的 adapter', async () => {
    const v1 = { ...makeAdapter(), $disconnect: vi.fn().mockResolvedValue(undefined) };
    const v2 = { ...makeAdapter(), close: vi.fn() };
    const v3 = { ...makeAdapter(), $disconnect: vi.fn().mockRejectedValue(new Error('boom')) };
    const factory = vi.fn().mockResolvedValueOnce(v1).mockResolvedValueOnce(v2);
    manager.registerFactory('mock', factory);
    await manager.addDataSource(makeConfig('ds1'));

    await manager.reload('ds1');
    manager.close('ds1');
    manager.register('ds2', v3);
    manager.remove('ds2');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(v1.$disconnect).toHaveBeenCalledOnce();
    expect(v2.close).toHaveBeenCalledOnce();
    expect(v3.$disconnect).toHaveBeenCalledOnce();
  });
});
