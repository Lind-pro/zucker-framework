import { describe, it, expect, beforeEach } from 'vitest';
import { DataReferenceManager, DataReferencedException, DATA_REFERENCE_TYPES } from './reference-manager';
import type { DataReferenceProvider, DataReference } from './reference-manager';

function createProvider(type: string, refs: DataReference[]): DataReferenceProvider {
  return {
    type,
    getReferences: async (_dataType: string, dataId: string) =>
      refs.filter((r) => r.dataId === dataId),
    getAllReferences: async () => refs,
  };
}

describe('DataReferenceManager', () => {
  let manager: DataReferenceManager;

  beforeEach(() => {
    manager = new DataReferenceManager();
  });

  it('should register and retrieve providers', () => {
    const provider = createProvider('device', []);
    manager.registerProvider(provider);
    expect(manager.getProvider('device')).toBe(provider);
    expect(manager.getProviders()).toHaveLength(1);
  });

  it('should unregister providers', () => {
    manager.registerProvider(createProvider('device', []));
    manager.unregisterProvider('device');
    expect(manager.getProvider('device')).toBeUndefined();
    expect(manager.getProviders()).toHaveLength(0);
  });

  it('should return empty array for empty dataType or dataId', async () => {
    manager.registerProvider(
      createProvider('x', [{ dataType: 'x', dataId: '1', referenceType: 'y', referenceId: '2' }]),
    );
    expect(await manager.getReferences('', '1')).toEqual([]);
    expect(await manager.getReferences('x', '')).toEqual([]);
  });

  it('should collect references from all providers', async () => {
    const ref1: DataReference = { dataType: 'device', dataId: 'd1', referenceType: 'gateway', referenceId: 'g1' };
    const ref2: DataReference = { dataType: 'device', dataId: 'd1', referenceType: 'network', referenceId: 'n1' };
    manager.registerProvider(createProvider('gateway', [ref1]));
    manager.registerProvider(createProvider('network', [ref2]));
    const refs = await manager.getReferences('device', 'd1');
    expect(refs).toHaveLength(2);
  });

  it('should check hasReferences (short-circuits on first)', async () => {
    const ref: DataReference = { dataType: 'device', dataId: 'd1', referenceType: 'gw', referenceId: 'g1' };
    manager.registerProvider(createProvider('gw', [ref]));
    expect(await manager.hasReferences('device', 'd1')).toBe(true);
    expect(await manager.hasReferences('device', 'd999')).toBe(false);
  });

  it('should assertNoReferences pass when no references exist', async () => {
    manager.registerProvider(createProvider('gw', []));
    await expect(manager.assertNoReferences('device', 'd1')).resolves.toBeUndefined();
  });

  it('should assertNoReferences throw DataReferencedException when references exist', async () => {
    const ref: DataReference = {
      dataType: 'device',
      dataId: 'd1',
      referenceType: 'gateway',
      referenceId: 'g1',
      referenceName: 'Gateway 1',
    };
    manager.registerProvider(createProvider('gw', [ref]));
    await expect(manager.assertNoReferences('device', 'd1')).rejects.toThrow(DataReferencedException);
  });

  it('should getAllReferences return results from the matching provider', async () => {
    const refs: DataReference[] = [
      { dataType: 'network', dataId: 'n1', referenceType: 'device', referenceId: 'd1' },
      { dataType: 'network', dataId: 'n2', referenceType: 'device', referenceId: 'd2' },
    ];
    manager.registerProvider(createProvider('network', refs));
    const result = await manager.getAllReferences('network');
    expect(result).toHaveLength(2);
  });

  it('should getAllReferences return empty for unknown type', async () => {
    const result = await manager.getAllReferences('unknown');
    expect(result).toEqual([]);
  });

  it('should return multiple providers from getProviders', () => {
    manager.registerProvider(createProvider('a', []));
    manager.registerProvider(createProvider('b', []));
    expect(manager.getProviders()).toHaveLength(2);
  });
});

describe('DataReferencedException', () => {
  it('should contain dataType, dataId, and referenceList', () => {
    const refs: DataReference[] = [
      { dataType: 'device', dataId: 'd1', referenceType: 'gw', referenceId: 'g1', referenceName: 'GW1' },
    ];
    const err = new DataReferencedException('device', 'd1', refs);
    expect(err.dataType).toBe('device');
    expect(err.dataId).toBe('d1');
    expect(err.referenceList).toEqual(refs);
    expect(err.getStatus()).toBe(400);
  });

  it('should format message with reference names', () => {
    const refs: DataReference[] = [
      { dataType: 'device', dataId: 'd1', referenceType: 'gw', referenceId: 'g1', referenceName: 'GW1' },
      { dataType: 'device', dataId: 'd1', referenceType: 'net', referenceId: 'n1' },
    ];
    const err = new DataReferencedException('device', 'd1', refs);
    const response = err.getResponse() as Record<string, unknown>;
    const message = response.message as string;
    expect(message).toContain('GW1');
    expect(message).toContain('net:n1');
  });
});

describe('DATA_REFERENCE_TYPES', () => {
  it('should have expected constants', () => {
    expect(DATA_REFERENCE_TYPES.DEVICE_GATEWAY).toBe('device-gateway');
    expect(DATA_REFERENCE_TYPES.NETWORK).toBe('network');
    expect(DATA_REFERENCE_TYPES.RELATION).toBe('relation');
    expect(DATA_REFERENCE_TYPES.PROTOCOL).toBe('protocol');
  });
});
