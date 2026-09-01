import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DefaultNetworkManager } from './network-manager';
import type { NetworkConfigManager } from './network-manager';
import type { NetworkProvider } from './network-provider';
import type { Network } from './network';
import type { NetworkType } from './network-type';
import { NetworkTypes } from './network-type';
import { Transports } from './transport';

function createMockNetwork(id: string, overrides?: Partial<Network>): Network {
  return {
    id,
    type: NetworkTypes.TCP_SERVER,
    shutdown: vi.fn(),
    isAlive: () => true,
    isAutoReload: () => false,
    ...overrides,
  };
}

function createMockProvider(
  type: NetworkType,
  networkFactory?: (config: unknown) => Network,
): NetworkProvider<unknown> {
  const factory = networkFactory ?? ((config: any) => createMockNetwork(config?.id ?? 'mock'));
  return {
    type,
    createNetwork: vi.fn(async (config) => factory(config)),
    reload: vi.fn(async (_network, config) => factory(config)),
    createConfig: vi.fn(async (props) => ({ id: props.id })),
    isReusable: () => false,
  };
}

function createMockConfigManager(configs?: Record<string, any>): NetworkConfigManager {
  return {
    getConfig: vi.fn(async (type, id) => {
      const key = `${type.id}/${id}`;
      return configs?.[key] ?? {
        id,
        type: type.id,
        name: `Test ${id}`,
        enabled: true,
        configurations: {},
      };
    }),
  };
}

describe('DefaultNetworkManager', () => {
  let manager: DefaultNetworkManager;
  let configManager: NetworkConfigManager;

  beforeEach(() => {
    vi.useFakeTimers();
    configManager = createMockConfigManager();
    manager = new DefaultNetworkManager(configManager);
  });

  afterEach(async () => {
    await manager.onModuleDestroy();
    vi.useRealTimers();
  });

  // ---- provider registration ----

  it('should register and retrieve a provider', () => {
    const provider = createMockProvider(NetworkTypes.TCP_SERVER);
    manager.registerProvider(provider);

    expect(manager.getProvider('TCP_SERVER')).toBe(provider);
    expect(manager.getProviders()).toContain(provider);
  });

  it('should return undefined for unregistered provider', () => {
    expect(manager.getProvider('UNKNOWN')).toBeUndefined();
  });

  // ---- getNetwork ----

  it('should create network on first getNetwork call', async () => {
    const provider = createMockProvider(NetworkTypes.TCP_SERVER);
    manager.registerProvider(provider);

    const network = await manager.getNetwork(NetworkTypes.TCP_SERVER, 'srv-1');
    expect(network).toBeDefined();
    expect(network.id).toBe('srv-1');
    expect(provider.createNetwork).toHaveBeenCalledTimes(1);
  });

  it('should return cached network on subsequent calls', async () => {
    const provider = createMockProvider(NetworkTypes.TCP_SERVER);
    manager.registerProvider(provider);

    const n1 = await manager.getNetwork(NetworkTypes.TCP_SERVER, 'srv-1');
    const n2 = await manager.getNetwork(NetworkTypes.TCP_SERVER, 'srv-1');
    expect(n1).toBe(n2);
    expect(provider.createNetwork).toHaveBeenCalledTimes(1);
  });

  it('should throw for unsupported network type', async () => {
    await expect(
      manager.getNetwork(NetworkTypes.MQTT_CLIENT, 'mqtt-1'),
    ).rejects.toThrow('Unsupported network type');
  });

  it('should throw for disabled config', async () => {
    const disabledConfigManager = createMockConfigManager({
      'TCP_SERVER/disabled-1': {
        id: 'disabled-1',
        type: 'TCP_SERVER',
        name: 'Disabled',
        enabled: false,
        configurations: {},
      },
    });
    const mgr = new DefaultNetworkManager(disabledConfigManager);
    const provider = createMockProvider(NetworkTypes.TCP_SERVER);
    mgr.registerProvider(provider);

    await expect(
      mgr.getNetwork(NetworkTypes.TCP_SERVER, 'disabled-1'),
    ).rejects.toThrow('not found or disabled');

    await mgr.onModuleDestroy();
  });

  // ---- getNetworks ----

  it('should list all created networks', async () => {
    const provider = createMockProvider(NetworkTypes.TCP_SERVER);
    manager.registerProvider(provider);

    await manager.getNetwork(NetworkTypes.TCP_SERVER, 'a');
    await manager.getNetwork(NetworkTypes.TCP_SERVER, 'b');

    const networks = manager.getNetworks();
    expect(networks).toHaveLength(2);
  });

  // ---- reload ----

  it('should reload an existing network', async () => {
    const provider = createMockProvider(NetworkTypes.TCP_SERVER);
    manager.registerProvider(provider);

    await manager.getNetwork(NetworkTypes.TCP_SERVER, 'srv-1');
    await manager.reload(NetworkTypes.TCP_SERVER, 'srv-1');

    expect(provider.reload).toHaveBeenCalledTimes(1);
  });

  it('should create network on reload if not cached', async () => {
    const provider = createMockProvider(NetworkTypes.TCP_SERVER);
    manager.registerProvider(provider);

    await manager.reload(NetworkTypes.TCP_SERVER, 'new-1');

    expect(provider.createNetwork).toHaveBeenCalledTimes(1);
  });

  // ---- shutdown ----

  it('should shutdown a network without removing from cache', async () => {
    const mockShutdown = vi.fn();
    const provider = createMockProvider(NetworkTypes.TCP_SERVER, () =>
      createMockNetwork('s1', { shutdown: mockShutdown }),
    );
    manager.registerProvider(provider);

    await manager.getNetwork(NetworkTypes.TCP_SERVER, 's1');
    await manager.shutdown(NetworkTypes.TCP_SERVER, 's1');

    expect(mockShutdown).toHaveBeenCalledTimes(1);
    // Still in cache
    expect(manager.getNetworks()).toHaveLength(1);
  });

  it('should do nothing when shutting down non-existent network', async () => {
    await expect(
      manager.shutdown(NetworkTypes.TCP_SERVER, 'none'),
    ).resolves.toBeUndefined();
  });

  // ---- destroy ----

  it('should destroy a network and remove from cache', async () => {
    const mockShutdown = vi.fn();
    const provider = createMockProvider(NetworkTypes.TCP_SERVER, () =>
      createMockNetwork('d1', { shutdown: mockShutdown }),
    );
    manager.registerProvider(provider);

    await manager.getNetwork(NetworkTypes.TCP_SERVER, 'd1');
    await manager.destroy(NetworkTypes.TCP_SERVER, 'd1');

    expect(mockShutdown).toHaveBeenCalledTimes(1);
    expect(manager.getNetworks()).toHaveLength(0);
  });

  // ---- health check (auto-reload) ----

  it('should auto-reload dead networks with autoReload=true', async () => {
    let alive = true;
    const provider = createMockProvider(NetworkTypes.TCP_SERVER, () =>
      createMockNetwork('auto-1', {
        isAlive: () => alive,
        isAutoReload: () => true,
      }),
    );
    manager.registerProvider(provider);

    await manager.getNetwork(NetworkTypes.TCP_SERVER, 'auto-1');

    // Simulate network going down
    alive = false;

    // Trigger health check
    await vi.advanceTimersByTimeAsync(10_000);

    expect(provider.reload).toHaveBeenCalled();
  });

  it('should not reload alive networks', async () => {
    const provider = createMockProvider(NetworkTypes.TCP_SERVER, () =>
      createMockNetwork('alive-1', {
        isAlive: () => true,
        isAutoReload: () => true,
      }),
    );
    manager.registerProvider(provider);

    await manager.getNetwork(NetworkTypes.TCP_SERVER, 'alive-1');

    await vi.advanceTimersByTimeAsync(10_000);

    expect(provider.reload).not.toHaveBeenCalled();
  });

  // ---- onModuleDestroy ----

  it('should shutdown all networks on module destroy', async () => {
    const shutdownFns = [vi.fn(), vi.fn()];
    let idx = 0;
    const provider = createMockProvider(NetworkTypes.TCP_SERVER, () =>
      createMockNetwork(`n${idx}`, { shutdown: shutdownFns[idx++] }),
    );
    manager.registerProvider(provider);

    await manager.getNetwork(NetworkTypes.TCP_SERVER, 'n0');
    await manager.getNetwork(NetworkTypes.TCP_SERVER, 'n1');

    await manager.onModuleDestroy();

    expect(shutdownFns[0]).toHaveBeenCalledTimes(1);
    expect(shutdownFns[1]).toHaveBeenCalledTimes(1);
    expect(manager.getNetworks()).toHaveLength(0);
  });
});
