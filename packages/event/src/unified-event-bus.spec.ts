import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnifiedEventBus, type ClusterTransport } from './unified-event-bus';
import { DefaultTopicEventBus } from './topic-event-bus';

describe('UnifiedEventBus', () => {
  let localBus: DefaultTopicEventBus;
  let unifiedBus: UnifiedEventBus;

  beforeEach(() => {
    localBus = new DefaultTopicEventBus();
    unifiedBus = new UnifiedEventBus(localBus);
  });

  describe('publish (local only)', () => {
    it('should deliver events to subscribers', async () => {
      const handler = vi.fn();
      unifiedBus.subscribe('test/topic', handler);

      await unifiedBus.publish('test/topic', { data: 42 });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ payload: { data: 42 } }),
      );
    });

    it('should support wildcard subscriptions', async () => {
      const handler = vi.fn();
      unifiedBus.subscribe('entity/user/**', handler);

      await unifiedBus.publish('entity/user/create/after', { id: '1' });
      await unifiedBus.publish('entity/user/delete/before', { id: '2' });
      await unifiedBus.publish('entity/role/create/after', { id: '3' });

      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe('publishLocal', () => {
    it('should deliver events locally without cluster broadcast', async () => {
      const handler = vi.fn();
      unifiedBus.subscribe('local/event', handler);

      await unifiedBus.publishLocal('local/event', { local: true });

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('subscribe', () => {
    it('should return subscription that can be unsubscribed', async () => {
      const handler = vi.fn();
      const sub = unifiedBus.subscribe('test/unsub', handler);

      await unifiedBus.publish('test/unsub', {});
      expect(handler).toHaveBeenCalledTimes(1);

      sub.unsubscribe();
      await unifiedBus.publish('test/unsub', {});
      expect(handler).toHaveBeenCalledTimes(1); // Not called again
    });
  });

  describe('with ClusterTransport', () => {
    it('should broadcast to cluster on publish', async () => {
      const clusterTransport: ClusterTransport = {
        broadcast: vi.fn().mockResolvedValue(undefined),
        onRemoteEvent: vi.fn(),
      };

      const clusteredBus = new UnifiedEventBus(localBus, clusterTransport);
      await clusteredBus.publish('cluster/test', { msg: 'hi' });

      expect(clusterTransport.broadcast).toHaveBeenCalledWith(
        'cluster/test',
        { msg: 'hi' },
      );
    });

    it('should NOT broadcast to cluster on publishLocal', async () => {
      const clusterTransport: ClusterTransport = {
        broadcast: vi.fn().mockResolvedValue(undefined),
        onRemoteEvent: vi.fn(),
      };

      const clusteredBus = new UnifiedEventBus(localBus, clusterTransport);
      await clusteredBus.publishLocal('local/only', { msg: 'hi' });

      expect(clusterTransport.broadcast).not.toHaveBeenCalled();
    });

    it('should replay remote events on local bus', async () => {
      let remoteHandler: ((topic: string, payload: unknown) => void) | undefined;
      const clusterTransport: ClusterTransport = {
        broadcast: vi.fn().mockResolvedValue(undefined),
        onRemoteEvent: (handler) => { remoteHandler = handler; },
      };

      const clusteredBus = new UnifiedEventBus(localBus, clusterTransport);

      const localHandler = vi.fn();
      clusteredBus.subscribe('remote/event', localHandler);

      // Simulate remote event arriving
      remoteHandler!('remote/event', { from: 'node-2' });

      // Wait for async event propagation
      await new Promise((r) => setTimeout(r, 10));

      expect(localHandler).toHaveBeenCalledTimes(1);
    });

    it('should handle cluster broadcast failure gracefully', async () => {
      const clusterTransport: ClusterTransport = {
        broadcast: vi.fn().mockRejectedValue(new Error('network error')),
        onRemoteEvent: vi.fn(),
      };

      const clusteredBus = new UnifiedEventBus(localBus, clusterTransport);

      // Should not throw, just log warning
      await expect(
        clusteredBus.publish('fail/test', {}),
      ).resolves.toBeUndefined();
    });
  });
});
