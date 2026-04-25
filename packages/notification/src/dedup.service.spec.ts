import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  InMemoryNotificationDedup,
  NotificationPriority,
  PriorityNotificationQueue,
} from './dedup.service';

describe('InMemoryNotificationDedup', () => {
  let dedup: InMemoryNotificationDedup;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    dedup?.dispose();
    vi.useRealTimers();
  });

  describe('isDuplicate', () => {
    it('should return false for unseen key', () => {
      dedup = new InMemoryNotificationDedup(5000);
      expect(dedup.isDuplicate('key1')).toBe(false);
    });

    it('should return true within the dedup window', () => {
      dedup = new InMemoryNotificationDedup(5000);
      dedup.markSent('key1');
      expect(dedup.isDuplicate('key1')).toBe(true);
    });

    it('should return false after the dedup window expires', () => {
      dedup = new InMemoryNotificationDedup(5000);
      dedup.markSent('key1');
      vi.advanceTimersByTime(5000);
      expect(dedup.isDuplicate('key1')).toBe(false);
    });

    it('should return false just at window boundary', () => {
      dedup = new InMemoryNotificationDedup(1000);
      dedup.markSent('key1');
      vi.advanceTimersByTime(1000);
      expect(dedup.isDuplicate('key1')).toBe(false);
    });

    it('should return true just before window boundary', () => {
      dedup = new InMemoryNotificationDedup(1000);
      dedup.markSent('key1');
      vi.advanceTimersByTime(999);
      expect(dedup.isDuplicate('key1')).toBe(true);
    });
  });

  describe('markSent', () => {
    it('should mark a key as sent so isDuplicate returns true', () => {
      dedup = new InMemoryNotificationDedup(5000);
      expect(dedup.isDuplicate('key1')).toBe(false);
      dedup.markSent('key1');
      expect(dedup.isDuplicate('key1')).toBe(true);
    });

    it('should handle multiple different keys independently', () => {
      dedup = new InMemoryNotificationDedup(5000);
      dedup.markSent('key1');
      expect(dedup.isDuplicate('key1')).toBe(true);
      expect(dedup.isDuplicate('key2')).toBe(false);
    });

    it('should refresh timestamp when marking the same key again', () => {
      dedup = new InMemoryNotificationDedup(1000);
      dedup.markSent('key1');
      vi.advanceTimersByTime(800);
      dedup.markSent('key1'); // refresh
      vi.advanceTimersByTime(800);
      // 1600ms from first mark, but only 800ms from second mark
      expect(dedup.isDuplicate('key1')).toBe(true);
    });
  });

  describe('cleanup', () => {
    it('should remove expired records', () => {
      dedup = new InMemoryNotificationDedup(1000);
      dedup.markSent('key1');
      dedup.markSent('key2');
      vi.advanceTimersByTime(1000);
      dedup.cleanup();
      expect(dedup.isDuplicate('key1')).toBe(false);
      expect(dedup.isDuplicate('key2')).toBe(false);
    });

    it('should keep non-expired records', () => {
      dedup = new InMemoryNotificationDedup(2000);
      dedup.markSent('key1');
      vi.advanceTimersByTime(500);
      dedup.markSent('key2');
      vi.advanceTimersByTime(1500);
      // key1: 2000ms old (expired), key2: 1500ms old (not expired)
      dedup.cleanup();
      expect(dedup.isDuplicate('key1')).toBe(false);
      expect(dedup.isDuplicate('key2')).toBe(true);
    });
  });

  describe('auto-cleanup timer', () => {
    it('should automatically run cleanup at window intervals', () => {
      dedup = new InMemoryNotificationDedup(1000);
      dedup.markSent('key1');
      // Advance past the cleanup interval
      vi.advanceTimersByTime(1000);
      // Auto cleanup should have run; key1 is now expired
      expect(dedup.isDuplicate('key1')).toBe(false);
    });

    it('should clear timer on dispose', () => {
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
      dedup = new InMemoryNotificationDedup(1000);
      dedup.dispose();
      expect(clearIntervalSpy).toHaveBeenCalled();
      clearIntervalSpy.mockRestore();
    });

    it('should be safe to call dispose multiple times', () => {
      dedup = new InMemoryNotificationDedup(1000);
      dedup.dispose();
      dedup.dispose(); // should not throw
    });
  });

  describe('buildKey', () => {
    it('should concatenate channel, recipient, and contentHash', () => {
      expect(InMemoryNotificationDedup.buildKey('EMAIL', 'user@test.com', 'abc123')).toBe(
        'EMAIL:user@test.com:abc123',
      );
    });

    it('should produce different keys for different inputs', () => {
      const key1 = InMemoryNotificationDedup.buildKey('EMAIL', 'a@test.com', 'hash1');
      const key2 = InMemoryNotificationDedup.buildKey('SMS', 'a@test.com', 'hash1');
      const key3 = InMemoryNotificationDedup.buildKey('EMAIL', 'b@test.com', 'hash1');
      expect(key1).not.toBe(key2);
      expect(key1).not.toBe(key3);
    });
  });
});

describe('PriorityNotificationQueue', () => {
  it('should enqueue and dequeue in priority order (highest first)', () => {
    const queue = new PriorityNotificationQueue();
    queue.enqueue({ priority: NotificationPriority.LOW });
    queue.enqueue({ priority: NotificationPriority.URGENT });
    queue.enqueue({ priority: NotificationPriority.NORMAL });
    queue.enqueue({ priority: NotificationPriority.HIGH });

    expect(queue.dequeue()!.priority).toBe(NotificationPriority.URGENT);
    expect(queue.dequeue()!.priority).toBe(NotificationPriority.HIGH);
    expect(queue.dequeue()!.priority).toBe(NotificationPriority.NORMAL);
    expect(queue.dequeue()!.priority).toBe(NotificationPriority.LOW);
  });

  it('should default to NORMAL priority when not specified', () => {
    const queue = new PriorityNotificationQueue();
    queue.enqueue({ priority: NotificationPriority.HIGH });
    queue.enqueue({}); // no priority = NORMAL
    queue.enqueue({ priority: NotificationPriority.LOW });

    expect(queue.dequeue()!.priority).toBe(NotificationPriority.HIGH);
    expect(queue.dequeue()!.priority).toBeUndefined(); // the item itself has no priority field
    expect(queue.dequeue()!.priority).toBe(NotificationPriority.LOW);
  });

  it('should return undefined when dequeuing from empty queue', () => {
    const queue = new PriorityNotificationQueue();
    expect(queue.dequeue()).toBeUndefined();
  });

  it('should report correct size', () => {
    const queue = new PriorityNotificationQueue();
    expect(queue.size).toBe(0);
    queue.enqueue({ priority: NotificationPriority.NORMAL });
    queue.enqueue({ priority: NotificationPriority.HIGH });
    expect(queue.size).toBe(2);
    queue.dequeue();
    expect(queue.size).toBe(1);
  });

  it('should report isEmpty correctly', () => {
    const queue = new PriorityNotificationQueue();
    expect(queue.isEmpty()).toBe(true);
    queue.enqueue({ priority: NotificationPriority.LOW });
    expect(queue.isEmpty()).toBe(false);
    queue.dequeue();
    expect(queue.isEmpty()).toBe(true);
  });

  it('should peek without removing', () => {
    const queue = new PriorityNotificationQueue();
    queue.enqueue({ priority: NotificationPriority.HIGH });
    queue.enqueue({ priority: NotificationPriority.LOW });
    expect(queue.peek()!.priority).toBe(NotificationPriority.HIGH);
    expect(queue.size).toBe(2); // peek does not remove
  });

  it('should clear all items', () => {
    const queue = new PriorityNotificationQueue();
    queue.enqueue({ priority: NotificationPriority.HIGH });
    queue.enqueue({ priority: NotificationPriority.LOW });
    queue.clear();
    expect(queue.isEmpty()).toBe(true);
    expect(queue.size).toBe(0);
  });

  it('should maintain insertion order for same priority', () => {
    const queue = new PriorityNotificationQueue<{ priority: NotificationPriority; id: string }>();
    queue.enqueue({ priority: NotificationPriority.NORMAL, id: 'first' });
    queue.enqueue({ priority: NotificationPriority.NORMAL, id: 'second' });
    queue.enqueue({ priority: NotificationPriority.NORMAL, id: 'third' });

    expect(queue.dequeue()!.id).toBe('first');
    expect(queue.dequeue()!.id).toBe('second');
    expect(queue.dequeue()!.id).toBe('third');
  });
});
