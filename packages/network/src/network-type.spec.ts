import { describe, it, expect } from 'vitest';
import { networkType, NetworkTypes, networkTypeRegistry } from './network-type';

describe('networkType', () => {
  it('should create a NetworkType with id and name', () => {
    const t = networkType('CUSTOM', 'Custom Protocol');
    expect(t.id).toBe('CUSTOM');
    expect(t.name).toBe('Custom Protocol');
  });

  it('should default name to id when not provided', () => {
    const t = networkType('RAW');
    expect(t.name).toBe('RAW');
  });
});

describe('NetworkTypes', () => {
  it('should define TCP_CLIENT', () => {
    expect(NetworkTypes.TCP_CLIENT.id).toBe('TCP_CLIENT');
    expect(NetworkTypes.TCP_CLIENT.name).toBe('TCP Client');
  });

  it('should define all built-in types', () => {
    const ids = Object.values(NetworkTypes).map((t) => t.id);
    expect(ids).toContain('TCP_CLIENT');
    expect(ids).toContain('TCP_SERVER');
    expect(ids).toContain('HTTP_CLIENT');
    expect(ids).toContain('HTTP_SERVER');
    expect(ids).toContain('MQTT_CLIENT');
    expect(ids).toContain('MQTT_SERVER');
    expect(ids).toContain('WEB_SOCKET_CLIENT');
    expect(ids).toContain('WEB_SOCKET_SERVER');
    expect(ids).toContain('UDP');
  });
});

describe('networkTypeRegistry', () => {
  it('should lookup built-in types (case insensitive)', () => {
    expect(networkTypeRegistry.lookup('tcp_client')).toBeDefined();
    expect(networkTypeRegistry.lookup('TCP_CLIENT')).toBeDefined();
    expect(networkTypeRegistry.lookup('Tcp_Client')).toBeDefined();
  });

  it('should return undefined for unknown type', () => {
    expect(networkTypeRegistry.lookup('NONEXISTENT')).toBeUndefined();
  });

  it('should register a custom type', () => {
    const custom = networkType('COAP', 'CoAP');
    networkTypeRegistry.register(custom);

    expect(networkTypeRegistry.lookup('COAP')).toBe(custom);
  });

  it('should register multiple types at once', () => {
    const types = [
      networkType('PROTO_A', 'Protocol A'),
      networkType('PROTO_B', 'Protocol B'),
    ];
    networkTypeRegistry.registerAll(types);

    expect(networkTypeRegistry.lookup('PROTO_A')).toBe(types[0]);
    expect(networkTypeRegistry.lookup('PROTO_B')).toBe(types[1]);
  });

  it('should list all registered types', () => {
    const all = networkTypeRegistry.getAll();
    expect(all.length).toBeGreaterThanOrEqual(9); // 9 built-in + any custom
  });
});
