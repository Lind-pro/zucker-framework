import { describe, it, expect, beforeEach } from 'vitest';
import { GatewayManager } from './gateway-manager';
import { GatewayState } from './device-gateway';
import { ProtocolRegistry } from './codec';
import type { DeviceGateway, DeviceGatewayConfig } from './device-gateway';

function makeGateway(id: string, initialState = GatewayState.STOPPED): DeviceGateway {
  const config: DeviceGatewayConfig = {
    id,
    name: `GW-${id}`,
    networkId: 'net1',
    protocolId: 'p1',
    transport: 'http',
  };
  return {
    config,
    state: initialState,
    async start() { (this as DeviceGateway & { state: GatewayState }).state = GatewayState.RUNNING; },
    async pause() { (this as DeviceGateway & { state: GatewayState }).state = GatewayState.PAUSED; },
    async shutdown() { (this as DeviceGateway & { state: GatewayState }).state = GatewayState.STOPPED; },
    getSessionCount() { return 3; },
    getSession() { return undefined; },
    async sendDownstream() {},
  };
}

describe('GatewayManager', () => {
  let manager: GatewayManager;

  beforeEach(() => {
    manager = new GatewayManager(new ProtocolRegistry());
  });

  it('registers and retrieves gateways', () => {
    manager.register(makeGateway('gw1'));
    expect(manager.get('gw1')).toBeDefined();
  });

  it('throws on duplicate registration', () => {
    manager.register(makeGateway('gw1'));
    expect(() => manager.register(makeGateway('gw1'))).toThrow();
  });

  it('unregisters a gateway', () => {
    manager.register(makeGateway('gw1'));
    manager.unregister('gw1');
    expect(manager.get('gw1')).toBeUndefined();
  });

  it('getAll returns all registered gateways', () => {
    manager.register(makeGateway('gw1'));
    manager.register(makeGateway('gw2'));
    expect(manager.getAll()).toHaveLength(2);
  });

  it('startAll starts all gateways', async () => {
    const gw1 = makeGateway('gw1');
    const gw2 = makeGateway('gw2');
    manager.register(gw1);
    manager.register(gw2);
    await manager.startAll();
    expect(gw1.state).toBe(GatewayState.RUNNING);
    expect(gw2.state).toBe(GatewayState.RUNNING);
  });

  it('shutdownAll stops all gateways', async () => {
    const gw1 = makeGateway('gw1', GatewayState.RUNNING);
    manager.register(gw1);
    await manager.shutdownAll();
    expect(gw1.state).toBe(GatewayState.STOPPED);
  });

  it('getSummary counts correctly', () => {
    manager.register(makeGateway('gw1', GatewayState.RUNNING));
    manager.register(makeGateway('gw2', GatewayState.RUNNING));
    manager.register(makeGateway('gw3', GatewayState.STOPPED));
    const summary = manager.getSummary();
    expect(summary.total).toBe(3);
    expect(summary.running).toBe(2);
    expect(summary.stopped).toBe(1);
    expect(summary.totalSessions).toBe(9); // 3 gateways × 3 sessions each
  });

  it('startAll tolerates individual gateway failures', async () => {
    const failing: DeviceGateway = {
      ...makeGateway('fail'),
      async start() { throw new Error('boot fail'); },
    };
    const good = makeGateway('good');
    manager.register(failing);
    manager.register(good);
    await expect(manager.startAll()).resolves.not.toThrow();
    expect(good.state).toBe(GatewayState.RUNNING);
  });
});
