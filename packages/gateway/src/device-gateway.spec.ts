import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AbstractDeviceGateway, GatewayState } from './device-gateway';
import type { DeviceGatewayConfig } from './device-gateway';
import { SessionState } from './device-session';
import type { DeviceSession } from './device-session';
import type { ProtocolSupport, MessageCodec, DecodeContext } from './codec';
import type { ThingManager, ThingsDataService } from '@zucker/things';
import { ThingState, createReportPropertyMessage } from '@zucker/things';
import type { Transport } from '@zucker/network';
import { Transports } from '@zucker/network';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeSession(thingId: string, gatewayId = 'gw1'): DeviceSession {
  return {
    sessionId: `session-${thingId}`,
    thingId,
    gatewayId,
    transport: Transports.HTTP as Transport,
    connectTime: Date.now(),
    lastPingTime: Date.now(),
    state: SessionState.CONNECTED,
    async send(_p: unknown) {},
    async close() { this.state = SessionState.CLOSED; },
    ping() { this.lastPingTime = Date.now(); },
    isAlive() { return this.state === SessionState.CONNECTED; },
  };
}

function makeThingManager(): ThingManager {
  const states = new Map<string, ThingState>();
  return {
    async getThingType() { return undefined; },
    async registerThingType() {},
    async getThing() { return undefined; },
    async registerThing() {},
    async unregisterThing() {},
    async updateState(thingId, state) { states.set(thingId, state); },
    async getEffectiveMetadata() { return undefined; },
    _states: states,
  } as unknown as ThingManager & { _states: Map<string, ThingState> };
}

function makeDataService(): ThingsDataService {
  const saved: unknown[] = [];
  return {
    async saveProperties(msg) { saved.push(msg); },
    async saveEvent(msg) { saved.push(msg); },
    async queryPropertyLogs() { return []; },
    async queryEventLogs() { return []; },
    async aggregateProperties() { return []; },
    _saved: saved,
  } as unknown as ThingsDataService & { _saved: unknown[] };
}

function makeCodec(decoded: unknown[] = []): MessageCodec {
  return {
    async decode() { return decoded as never; },
    async encode() { return { payload: null }; },
  };
}

function makeProtocol(codec: MessageCodec, transport = 'http'): ProtocolSupport {
  return {
    id: 'test-protocol',
    name: 'Test',
    transports: [transport],
    getCodec: (t) => (t === transport ? codec : undefined),
  };
}

// ── concrete subclass for testing ────────────────────────────────────────────

class TestGateway extends AbstractDeviceGateway {
  async start() { this.state = GatewayState.RUNNING; }
  async pause() { this.state = GatewayState.PAUSED; }
  async shutdown() {
    await this.closeAllSessions();
    this.state = GatewayState.STOPPED;
  }

  // expose protected methods for testing
  async injectSession(session: DeviceSession) {
    await this.onSessionConnected(session);
  }
  async disconnectSession(session: DeviceSession) {
    await this.onSessionClosed(session);
  }
  async processIncoming(ctx: DecodeContext) {
    await this.handleIncoming(ctx);
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('AbstractDeviceGateway', () => {
  let thingManager: ReturnType<typeof makeThingManager>;
  let dataService: ReturnType<typeof makeDataService>;
  let gateway: TestGateway;

  const config: DeviceGatewayConfig = {
    id: 'gw1',
    name: 'Test Gateway',
    networkId: 'net1',
    protocolId: 'test-protocol',
    transport: 'http',
  };

  beforeEach(() => {
    thingManager = makeThingManager();
    dataService = makeDataService();
    const codec = makeCodec();
    const protocol = makeProtocol(codec);
    gateway = new TestGateway(config, protocol, thingManager as unknown as ThingManager, dataService as unknown as ThingsDataService);
  });

  describe('lifecycle', () => {
    it('starts in STOPPED state', () => {
      expect(gateway.state).toBe(GatewayState.STOPPED);
    });

    it('transitions to RUNNING on start()', async () => {
      await gateway.start();
      expect(gateway.state).toBe(GatewayState.RUNNING);
    });

    it('transitions to PAUSED on pause()', async () => {
      await gateway.start();
      await gateway.pause();
      expect(gateway.state).toBe(GatewayState.PAUSED);
    });

    it('transitions to STOPPED and clears sessions on shutdown()', async () => {
      await gateway.start();
      const session = makeSession('d1');
      await gateway.injectSession(session);
      await gateway.shutdown();
      expect(gateway.state).toBe(GatewayState.STOPPED);
      expect(gateway.getSessionCount()).toBe(0);
    });
  });

  describe('session management', () => {
    it('registers session and marks device online', async () => {
      const session = makeSession('d1');
      await gateway.injectSession(session);
      expect(gateway.getSessionCount()).toBe(1);
      expect(gateway.getSession('d1')).toBe(session);
      expect((thingManager as unknown as { _states: Map<string, ThingState> })._states.get('d1')).toBe(ThingState.ONLINE);
    });

    it('removes session and marks device offline on disconnect', async () => {
      const session = makeSession('d1');
      await gateway.injectSession(session);
      await gateway.disconnectSession(session);
      expect(gateway.getSessionCount()).toBe(0);
      expect(session.state).toBe(SessionState.CLOSED);
      expect((thingManager as unknown as { _states: Map<string, ThingState> })._states.get('d1')).toBe(ThingState.OFFLINE);
    });
  });

  describe('sendDownstream', () => {
    it('sends payload to active session', async () => {
      const sent: unknown[] = [];
      const session = { ...makeSession('d1'), async send(p: unknown) { sent.push(p); } };
      await gateway.injectSession(session);
      await gateway.sendDownstream('d1', { cmd: 'reboot' });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toEqual({ cmd: 'reboot' });
    });

    it('throws when no session exists', async () => {
      await expect(gateway.sendDownstream('ghost', {})).rejects.toThrow();
    });
  });

  describe('message routing via handleIncoming', () => {
    it('calls saveProperties for ReportProperty messages', async () => {
      const msg = createReportPropertyMessage('d1', 'sensor', { temperature: 22 });
      const codec = makeCodec([msg]);
      const protocol = makeProtocol(codec);
      const gw = new TestGateway(config, protocol, thingManager as unknown as ThingManager, dataService as unknown as ThingsDataService);
      const session = makeSession('d1');
      await gw.processIncoming({ payload: {}, session });
      const ds = dataService as unknown as { _saved: unknown[] };
      expect(ds._saved).toHaveLength(1);
    });

    it('silently handles missing codec for transport', async () => {
      // protocol with no codec for 'http'
      const protocol: ProtocolSupport = {
        id: 'p', name: 'P', transports: [],
        getCodec: () => undefined,
      };
      const gw = new TestGateway(config, protocol, thingManager as unknown as ThingManager, dataService as unknown as ThingsDataService);
      const session = makeSession('d1');
      await expect(gw.processIncoming({ payload: {}, session })).resolves.not.toThrow();
    });

    it('silently handles codec decode error', async () => {
      const codec: MessageCodec = {
        async decode() { throw new Error('parse error'); },
        async encode() { return { payload: null }; },
      };
      const protocol = makeProtocol(codec);
      const gw = new TestGateway(config, protocol, thingManager as unknown as ThingManager, dataService as unknown as ThingsDataService);
      const session = makeSession('d1');
      await expect(gw.processIncoming({ payload: {}, session })).resolves.not.toThrow();
    });
  });
});
