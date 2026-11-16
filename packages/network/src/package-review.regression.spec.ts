import { afterEach, describe, expect, it, vi } from 'vitest';
import { DefaultNetworkManager } from './network-manager';
import { NetworkTypes } from './network-type';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('Package review regressions', () => {
  it.each(['shutdown', 'destroy', 'module-destroy'] as const)('R03: pending network creation is disposed during (%s)', async mode => {
    const creation = deferred<any>();
    const started = deferred<void>();
    const network = { id: 'n', type: NetworkTypes.TCP_SERVER, shutdown: vi.fn(async () => {}), isAlive: () => true, isAutoReload: () => false };
    const manager = new DefaultNetworkManager({ getConfig: async () => ({ id: 'n', type: 'TCP_SERVER', name: 'n', enabled: true, configurations: {} }) });
    manager.registerProvider({ type: NetworkTypes.TCP_SERVER, createConfig: async value => value,
      createNetwork: () => { started.resolve(); return creation.promise; }, reload: async () => network, isReusable: () => false });
    const pending = manager.getNetwork(NetworkTypes.TCP_SERVER, 'n');
    await started.promise;
    const closing = mode === 'module-destroy' ? manager.onModuleDestroy() : manager[mode](NetworkTypes.TCP_SERVER, 'n');
    creation.resolve(network);
    await expect(pending).rejects.toThrow();
    await closing;
    expect(network.shutdown).toHaveBeenCalledOnce();
    expect(manager.getNetworks()).toHaveLength(0);
    await manager.onModuleDestroy();

  });


  it.each(['shutdown', 'destroy', 'module-destroy'] as const)(
    'closes a late health reload result during %s', async mode => {
      vi.useFakeTimers();
      const started = deferred<void>();
      const reloading = deferred<any>();
      const old = { id: 'n', type: NetworkTypes.TCP_SERVER, shutdown: vi.fn(async () => {}), isAlive: () => false, isAutoReload: () => true };
      const fresh = { ...old, shutdown: vi.fn(async () => {}) };
      const manager = new DefaultNetworkManager({ getConfig: async () => ({ id: 'n', type: 'TCP_SERVER', name: 'n', enabled: true, configurations: {} }) });
      manager.registerProvider({ type: NetworkTypes.TCP_SERVER, createConfig: async value => value,
        createNetwork: async () => old, reload: () => { started.resolve(); return reloading.promise; }, isReusable: () => false });
      try {
        await manager.getNetwork(NetworkTypes.TCP_SERVER, 'n');
        await vi.advanceTimersByTimeAsync(10_000);
        await started.promise;
        const closing = mode === 'module-destroy' ? manager.onModuleDestroy() : manager[mode](NetworkTypes.TCP_SERVER, 'n');
        reloading.resolve(fresh);
        await closing;
        expect(fresh.shutdown).toHaveBeenCalledOnce();
        expect(old.shutdown).toHaveBeenCalledOnce();
        expect(manager.getNetworks()).toEqual(mode === 'shutdown' ? [old] : []);
        if (mode === 'shutdown') {
          await vi.advanceTimersByTimeAsync(10_000);
          expect(fresh.shutdown).toHaveBeenCalledOnce();
        }
      } finally {
        await manager.onModuleDestroy();
        vi.useRealTimers();
      }
    },
  );

  it('refuses new work after module destruction', async () => {
    const manager = new DefaultNetworkManager({ getConfig: vi.fn() });
    await manager.onModuleDestroy();
    await expect(manager.getNetwork(NetworkTypes.TCP_SERVER, 'n')).rejects.toThrow('closed');
    await expect(manager.reload(NetworkTypes.TCP_SERVER, 'n')).rejects.toThrow('closed');
  });

});
