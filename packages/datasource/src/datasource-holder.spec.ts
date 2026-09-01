import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataSourceHolder, getCurrentDataSourceId } from './datasource-holder';
import { DataSourceManager } from './datasource-manager';
import type { DatabaseAdapter } from './datasource-manager';
import { DataSourceNotFoundException } from './datasource-errors';

function makeAdapter(): DatabaseAdapter {
  return { model: vi.fn(), $transaction: vi.fn() };
}

function makeManager(adapters: Record<string, DatabaseAdapter> = {}): DataSourceManager {
  const mgr = new DataSourceManager();
  for (const [id, adapter] of Object.entries(adapters)) {
    mgr.register(id, adapter);
  }
  return mgr;
}

describe('DataSourceHolder', () => {
  let a1: DatabaseAdapter;
  let a2: DatabaseAdapter;
  let manager: DataSourceManager;
  let holder: DataSourceHolder;

  beforeEach(() => {
    a1 = makeAdapter();
    a2 = makeAdapter();
    manager = makeManager({ ds1: a1, ds2: a2 });
    holder = new DataSourceHolder(manager);
  });

  // ---------- useDataSource ----------

  it('useDataSource 在 fn 内 getCurrent() 返回指定 adapter', async () => {
    let captured: DatabaseAdapter | undefined;
    await holder.useDataSource('ds1', async (adapter) => {
      captured = adapter;
    });
    expect(captured).toBe(a1);
  });

  it('useDataSource 在 fn 内 getCurrentDataSourceId() 返回绑定 id', async () => {
    let idInside: string | undefined;
    await holder.useDataSource('ds2', async () => {
      idInside = getCurrentDataSourceId();
    });
    expect(idInside).toBe('ds2');
  });

  it('useDataSource 执行完毕后 getCurrentDataSourceId() 恢复为 undefined', async () => {
    await holder.useDataSource('ds1', async () => {});
    expect(getCurrentDataSourceId()).toBeUndefined();
  });

  it('useDataSource(不存在) 抛 DataSourceNotFoundException', async () => {
    await expect(holder.useDataSource('ghost', async () => {})).rejects.toThrow(
      DataSourceNotFoundException,
    );
  });

  // ---------- getCurrent ----------

  it('无上下文时 getCurrent() 返回默认数据源', () => {
    // manager 第一次 register 的 ds1 成为默认
    expect(holder.getCurrent()).toBe(a1);
  });

  it('useDataSource 内 getCurrent() 返回绑定数据源', async () => {
    let current: DatabaseAdapter | undefined;
    await holder.useDataSource('ds2', async () => {
      current = holder.getCurrent();
    });
    expect(current).toBe(a2);
  });

  // ---------- getDefault ----------

  it('getDefault() 返回 manager 默认数据源', () => {
    expect(holder.getDefault()).toBe(a1);
  });

  // ---------- getDataSource ----------

  it('getDataSource(id) 委托 manager 返回正确 adapter', () => {
    expect(holder.getDataSource('ds2')).toBe(a2);
  });

  // ---------- currentIsDefault / isDynamic ----------

  it('无上下文时 currentIsDefault() 为 true，isDynamic() 为 false', () => {
    expect(holder.currentIsDefault()).toBe(true);
    expect(holder.isDynamic()).toBe(false);
  });

  it('useDataSource 内 currentIsDefault() 为 false，isDynamic() 为 true', async () => {
    let isDefault: boolean | undefined;
    let isDynamic: boolean | undefined;
    await holder.useDataSource('ds1', async () => {
      isDefault = holder.currentIsDefault();
      isDynamic = holder.isDynamic();
    });
    expect(isDefault).toBe(false);
    expect(isDynamic).toBe(true);
  });

  // ---------- existing / currentExisting ----------

  it('existing(id) 委托 manager.existing()', () => {
    expect(holder.existing('ds1')).toBe(true);
    expect(holder.existing('ghost')).toBe(false);
  });

  it('currentExisting() 无动态上下文时返回 true（默认）', () => {
    expect(holder.currentExisting()).toBe(true);
  });

  it('currentExisting() 在 useDataSource 内返回 true', async () => {
    let result: boolean | undefined;
    await holder.useDataSource('ds1', async () => {
      result = holder.currentExisting();
    });
    expect(result).toBe(true);
  });

  // ---------- isReady / checkReady ----------

  it('isReady() 有默认数据源时返回 true', () => {
    expect(holder.isReady()).toBe(true);
  });

  it('isReady() 无数据源时返回 false', () => {
    const emptyHolder = new DataSourceHolder(makeManager());
    expect(emptyHolder.isReady()).toBe(false);
  });

  it('checkReady() 无数据源时抛 BusinessException', () => {
    const emptyHolder = new DataSourceHolder(makeManager());
    expect(() => emptyHolder.checkReady()).toThrow('DataSourceService not ready');
  });

  // ---------- 嵌套上下文隔离 ----------

  it('嵌套 useDataSource 内层上下文不干扰外层（AsyncLocalStorage 语义）', async () => {
    let innerCurrent: DatabaseAdapter | undefined;
    let outerCurrentAfterInner: DatabaseAdapter | undefined;

    await holder.useDataSource('ds1', async () => {
      // 嵌套切换到 ds2
      await holder.useDataSource('ds2', async () => {
        innerCurrent = holder.getCurrent();
      });
      // 内层结束后仍应是 ds1
      outerCurrentAfterInner = holder.getCurrent();
    });

    expect(innerCurrent).toBe(a2);
    expect(outerCurrentAfterInner).toBe(a1);
  });
});
