import { describe, it, expect } from 'vitest';
import { InMemoryDataSourceConfigRepository } from './datasource-config';
import type { DynamicDataSourceConfig } from './datasource-config';

function makeConfig(id: string): DynamicDataSourceConfig {
  return { id, name: `DS-${id}` };
}

describe('InMemoryDataSourceConfigRepository', () => {
  it('初始 findAll() 返回空数组', async () => {
    const repo = new InMemoryDataSourceConfigRepository();
    expect(await repo.findAll()).toEqual([]);
  });

  it('add() 后 findAll() 返回已添加配置', async () => {
    const repo = new InMemoryDataSourceConfigRepository();
    await repo.add(makeConfig('ds1'));
    await repo.add(makeConfig('ds2'));

    const all = await repo.findAll();
    expect(all).toHaveLength(2);
    expect(all.map((c) => c.id)).toEqual(expect.arrayContaining(['ds1', 'ds2']));
  });

  it('add() 返回传入的配置对象', async () => {
    const repo = new InMemoryDataSourceConfigRepository();
    const cfg = makeConfig('ds1');
    const result = await repo.add(cfg);
    expect(result).toBe(cfg);
  });

  it('findById() 返回已添加的配置', async () => {
    const repo = new InMemoryDataSourceConfigRepository();
    const cfg = makeConfig('ds1');
    await repo.add(cfg);

    const found = await repo.findById('ds1');
    expect(found).toBe(cfg);
  });

  it('findById() 不存在时返回 undefined', async () => {
    const repo = new InMemoryDataSourceConfigRepository();
    expect(await repo.findById('ghost')).toBeUndefined();
  });

  it('remove() 删除已有配置并返回该配置', async () => {
    const repo = new InMemoryDataSourceConfigRepository();
    const cfg = makeConfig('ds1');
    await repo.add(cfg);

    const removed = await repo.remove('ds1');
    expect(removed).toBe(cfg);
    expect(await repo.findById('ds1')).toBeUndefined();
  });

  it('remove() 删除不存在的 id 返回 undefined', async () => {
    const repo = new InMemoryDataSourceConfigRepository();
    expect(await repo.remove('ghost')).toBeUndefined();
  });

  it('add() 覆盖同 id 的旧配置', async () => {
    const repo = new InMemoryDataSourceConfigRepository();
    await repo.add(makeConfig('ds1'));
    const updated = { id: 'ds1', name: 'Updated' };
    await repo.add(updated);

    expect(await repo.findById('ds1')).toBe(updated);
    expect((await repo.findAll())).toHaveLength(1);
  });
});
