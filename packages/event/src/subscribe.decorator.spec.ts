import { describe, it, expect } from 'vitest';
import {
  Subscribe,
  getSubscriptions,
  SUBSCRIBE_KEY,
  SUBSCRIBE_METHODS_KEY,
  SubscribeFeature,
} from './subscribe.decorator';
import type { SubscribeOptions } from './subscribe.decorator';

const { Reflect } = globalThis;

describe('Subscribe decorator', () => {
  it('should store metadata for a single topic string', () => {
    class TestHandler {
      @Subscribe('/device/*/status')
      handleStatus(_payload: unknown): void {}
    }

    const subs = getSubscriptions(TestHandler);
    expect(subs).toHaveLength(1);
    expect(subs[0].options.topics).toEqual(['/device/*/status']);
  });

  it('should store metadata for array of topics', () => {
    class TestHandler {
      @Subscribe(['/device/*/online', '/device/*/offline'])
      handleConnection(_payload: unknown): void {}
    }

    const subs = getSubscriptions(TestHandler);
    expect(subs).toHaveLength(1);
    expect(subs[0].options.topics).toEqual(['/device/*/online', '/device/*/offline']);
  });

  it('should store metadata for SubscribeOptions object', () => {
    class TestHandler {
      @Subscribe({
        topics: ['/events/**'],
        id: 'custom-id',
        features: [SubscribeFeature.CLUSTER],
        priority: 10,
      })
      handleEvent(_payload: unknown): void {}
    }

    const subs = getSubscriptions(TestHandler);
    expect(subs).toHaveLength(1);
    expect(subs[0].options.id).toBe('custom-id');
    expect(subs[0].options.features).toEqual([SubscribeFeature.CLUSTER]);
    expect(subs[0].options.priority).toBe(10);
  });

  it('should default id to method name', () => {
    class TestHandler {
      @Subscribe('/test')
      myMethod(_payload: unknown): void {}
    }

    const subs = getSubscriptions(TestHandler);
    expect(subs[0].options.id).toBe('myMethod');
  });

  it('should default features to [LOCAL]', () => {
    class TestHandler {
      @Subscribe('/test')
      handle(_payload: unknown): void {}
    }

    const subs = getSubscriptions(TestHandler);
    expect(subs[0].options.features).toEqual([SubscribeFeature.LOCAL]);
  });

  it('should default priority to Infinity', () => {
    class TestHandler {
      @Subscribe('/test')
      handle(_payload: unknown): void {}
    }

    const subs = getSubscriptions(TestHandler);
    expect(subs[0].options.priority).toBe(Infinity);
  });

  it('should collect multiple subscriptions from one class', () => {
    class TestHandler {
      @Subscribe('/a')
      handleA(_payload: unknown): void {}

      @Subscribe('/b')
      handleB(_payload: unknown): void {}

      @Subscribe('/c')
      handleC(_payload: unknown): void {}
    }

    const subs = getSubscriptions(TestHandler);
    expect(subs).toHaveLength(3);
    expect(subs.map((s) => s.propertyKey)).toEqual(['handleA', 'handleB', 'handleC']);
  });

  it('should store method-level metadata via SUBSCRIBE_KEY', () => {
    class TestHandler {
      @Subscribe({ topics: ['/test'], id: 'test-sub', priority: 5 })
      handle(_payload: unknown): void {}
    }

    const metadata: SubscribeOptions = Reflect.getMetadata(
      SUBSCRIBE_KEY,
      TestHandler.prototype,
      'handle',
    );
    expect(metadata).toBeDefined();
    expect(metadata.topics).toEqual(['/test']);
    expect(metadata.id).toBe('test-sub');
    expect(metadata.priority).toBe(5);
  });

  it('should return empty array for class without subscriptions', () => {
    class NoSubscriptions {}
    const subs = getSubscriptions(NoSubscriptions);
    expect(subs).toEqual([]);
  });

  it('should store class-level metadata via SUBSCRIBE_METHODS_KEY', () => {
    class TestHandler {
      @Subscribe('/x')
      handleX(_payload: unknown): void {}
    }

    const methods = Reflect.getMetadata(SUBSCRIBE_METHODS_KEY, TestHandler);
    expect(methods).toBeDefined();
    expect(methods).toHaveLength(1);
  });
});

describe('SubscribeFeature', () => {
  it('should have correct enum values', () => {
    expect(SubscribeFeature.LOCAL).toBe('local');
    expect(SubscribeFeature.CLUSTER).toBe('cluster');
    expect(SubscribeFeature.SHARED).toBe('shared');
    expect(SubscribeFeature.BROKER).toBe('broker');
  });
});
