import { describe, it, expect } from 'vitest';
import { ProtocolRegistry } from './codec';
import type { ProtocolSupport, MessageCodec } from './codec';

function makeProtocol(id: string, transports: string[]): ProtocolSupport {
  const codecs = new Map<string, MessageCodec>();
  for (const t of transports) {
    codecs.set(t, {
      async decode() { return []; },
      async encode() { return { payload: null }; },
    });
  }
  return {
    id,
    name: `Protocol-${id}`,
    transports,
    getCodec: (t) => codecs.get(t),
  };
}

describe('ProtocolRegistry', () => {
  it('registers and retrieves a protocol', () => {
    const registry = new ProtocolRegistry();
    const p = makeProtocol('mqtt-v1', ['mqtt', 'mqtts']);
    registry.register(p);
    expect(registry.get('mqtt-v1')).toBe(p);
  });

  it('returns undefined for unknown protocol', () => {
    const registry = new ProtocolRegistry();
    expect(registry.get('unknown')).toBeUndefined();
  });

  it('getAll returns all registered protocols', () => {
    const registry = new ProtocolRegistry();
    registry.register(makeProtocol('p1', ['mqtt']));
    registry.register(makeProtocol('p2', ['http']));
    expect(registry.getAll()).toHaveLength(2);
  });

  it('unregisters a protocol', () => {
    const registry = new ProtocolRegistry();
    registry.register(makeProtocol('p1', ['mqtt']));
    registry.unregister('p1');
    expect(registry.get('p1')).toBeUndefined();
  });

  it('protocol returns correct codec for transport', () => {
    const p = makeProtocol('p1', ['mqtt', 'http']);
    expect(p.getCodec('mqtt')).toBeDefined();
    expect(p.getCodec('tcp')).toBeUndefined();
  });
});
