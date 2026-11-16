import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataSourceManager } from './datasource-manager';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('Package review regressions', () => {
  it('R04: datasource reload cannot resurrect a removed source', async () => {
    const creation = deferred<any>();
    const old = { model: vi.fn(), $transaction: vi.fn(), close: vi.fn() };
    const fresh = { model: vi.fn(), $transaction: vi.fn(), close: vi.fn() };
    const manager = new DataSourceManager();
    manager.registerFactory('test', () => creation.promise);
    manager.register('db', old, { id: 'db', name: 'db', type: 'test', url: 'synthetic' });
    const reloading = manager.reload('db');
    manager.remove('db');
    creation.resolve(fresh);
    await expect(reloading).rejects.toThrow();
    expect(manager.has('db')).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(fresh.close).toHaveBeenCalledOnce();
    expect(manager.getConfigs()).toEqual([]);
    manager.remove('db');
  });


  it.each(['close', 'register', 'reload'] as const)('a newer %s supersedes a pending reload', async operation => {
    const pending = deferred<any>();
    const make = () => ({ model: vi.fn(), $transaction: vi.fn(), close: vi.fn() });
    const old = make(); const late = make(); const winner = make();
    const manager = new DataSourceManager();
    manager.register('db', old, { id: 'db', name: 'db', type: 'test', url: 'synthetic' });
    manager.registerFactory('test', vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(winner));
    const reload = manager.reload('db');
    if (operation === 'register') manager.register('db', winner);
    else if (operation === 'close') manager.close('db');
    else await manager.reload('db');
    pending.resolve(late);
    await expect(reload).rejects.toThrow('superseded');
    await Promise.resolve();
    expect(late.close).toHaveBeenCalledOnce();
    if (operation === 'close') expect(manager.isClosed('db')).toBe(true);
    else expect(manager.getDataSource('db')).toBe(winner);
  });

  it('removing a pending add disposes its result without publishing its configuration', async () => {
    const pending = deferred<any>();
    const late = { model: vi.fn(), $transaction: vi.fn(), close: vi.fn() };
    const manager = new DataSourceManager();
    manager.registerFactory('test', () => pending.promise);
    const adding = manager.addDataSource({ id: 'db', name: 'db', type: 'test', url: 'synthetic' });
    manager.remove('db');
    pending.resolve(late);
    await expect(adding).rejects.toThrow('superseded');
    await Promise.resolve();
    expect(late.close).toHaveBeenCalledOnce();
    expect(manager.getConfigs()).toEqual([]);
    expect(manager.getDefault()).toBeUndefined();
  });

});
