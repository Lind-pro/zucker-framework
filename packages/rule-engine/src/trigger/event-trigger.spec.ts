import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventTrigger } from './event-trigger';
import type { EventTriggerConfig } from './event-trigger';
import type { TopicEventBus, TopicPayload } from '@zucker/event';

/**
 * 최소 TopicEventBus mock — subscribe 콜백을 저장했다가 수동으로 발화할 수 있다.
 */
function createMockEventBus() {
  type SubscribeCallback = (msg: TopicPayload) => void;
  const subscribers = new Map<string, SubscribeCallback[]>();

  const eventBus: TopicEventBus = {
    subscribe(topic: string, cb: SubscribeCallback) {
      const list = subscribers.get(topic) ?? [];
      list.push(cb);
      subscribers.set(topic, list);
      return {
        unsubscribe() {
          const current = subscribers.get(topic) ?? [];
          const idx = current.indexOf(cb);
          if (idx >= 0) current.splice(idx, 1);
        },
      };
    },
    publish: vi.fn(),
  } as unknown as TopicEventBus;

  function emit(topic: string, payload: unknown) {
    (subscribers.get(topic) ?? []).forEach((cb) => cb({ topic, payload } as TopicPayload));
  }

  return { eventBus, emit, subscribers };
}

describe('EventTrigger', () => {
  let trigger: EventTrigger;

  beforeEach(() => {
    trigger = new EventTrigger();
  });

  // ─── start / stop ────────────────────────────────────────────────────────────

  describe('start() / stop()', () => {
    it('start 후 isRunning()이 true여야 한다', () => {
      const { eventBus } = createMockEventBus();
      const config: EventTriggerConfig = { topic: 'device/alert' };
      trigger.start(config, eventBus, vi.fn());
      expect(trigger.isRunning()).toBe(true);
    });

    it('stop 후 isRunning()이 false여야 한다', () => {
      const { eventBus } = createMockEventBus();
      trigger.start({ topic: 'test' }, eventBus, vi.fn());
      trigger.stop();
      expect(trigger.isRunning()).toBe(false);
    });

    it('stop을 두 번 호출해도 오류가 나지 않아야 한다', () => {
      const { eventBus } = createMockEventBus();
      trigger.start({ topic: 'test' }, eventBus, vi.fn());
      expect(() => {
        trigger.stop();
        trigger.stop();
      }).not.toThrow();
    });
  });

  // ─── 이벤트 구독 및 handler 실행 ────────────────────────────────────────────

  describe('이벤트 수신 시 handler 실행', () => {
    it('구독한 topic으로 이벤트가 오면 handler가 호출되어야 한다', () => {
      const { eventBus, emit } = createMockEventBus();
      const handler = vi.fn();

      trigger.start({ topic: 'sensor/temperature' }, eventBus, handler);
      emit('sensor/temperature', { value: 36.5, unit: 'C' });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith({ value: 36.5, unit: 'C' });
    });

    it('다른 topic의 이벤트에는 반응하지 않아야 한다', () => {
      const { eventBus, emit } = createMockEventBus();
      const handler = vi.fn();

      trigger.start({ topic: 'device/alarm' }, eventBus, handler);
      emit('device/other', { value: 1 });

      expect(handler).not.toHaveBeenCalled();
    });

    it('이벤트가 여러 번 오면 handler도 여러 번 호출되어야 한다', () => {
      const { eventBus, emit } = createMockEventBus();
      const handler = vi.fn();

      trigger.start({ topic: 'heartbeat' }, eventBus, handler);
      emit('heartbeat', { seq: 1 });
      emit('heartbeat', { seq: 2 });
      emit('heartbeat', { seq: 3 });

      expect(handler).toHaveBeenCalledTimes(3);
    });
  });

  // ─── 취소 구독 ───────────────────────────────────────────────────────────────

  describe('취소 구독 (unsubscribe)', () => {
    it('stop 후에는 이벤트를 받아도 handler가 호출되지 않아야 한다', () => {
      const { eventBus, emit } = createMockEventBus();
      const handler = vi.fn();

      trigger.start({ topic: 'data/stream' }, eventBus, handler);
      emit('data/stream', { v: 1 });
      trigger.stop();
      emit('data/stream', { v: 2 });

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  // ─── async handler ───────────────────────────────────────────────────────────

  describe('비동기 handler', () => {
    it('async handler가 정상적으로 호출되어야 한다', async () => {
      const { eventBus, emit } = createMockEventBus();
      const results: unknown[] = [];
      const handler = vi.fn().mockImplementation(async (payload: unknown) => {
        results.push(payload);
      });

      trigger.start({ topic: 'async/topic' }, eventBus, handler);
      emit('async/topic', { msg: 'hello' });
      await Promise.resolve();

      expect(results).toEqual([{ msg: 'hello' }]);
    });
  });
});
