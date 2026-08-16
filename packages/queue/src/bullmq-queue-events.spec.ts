import type { QueueEvents } from 'bullmq';
import { BullMqQueueEvents } from './bullmq-queue-events';

const createQueueEvents = () => {
  const handlers = new Map<string, Set<(event: unknown) => void>>();
  return {
    on: vi.fn((event: string, handler: (value: unknown) => void) => {
      const values = handlers.get(event) ?? new Set();
      values.add(handler);
      handlers.set(event, values);
    }),
    off: vi.fn((event: string, handler: (value: unknown) => void) => {
      handlers.get(event)?.delete(handler);
    }),
    emit: (event: string, value: unknown) => {
      for (const handler of handlers.get(event) ?? []) handler(value);
    },
    waitUntilReady: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
};

describe('BullMqQueueEvents', () => {
  it('maps global events with their queue name and supports unsubscribe', () => {
    const listener = createQueueEvents();
    const completed = vi.fn();
    const progress = vi.fn();
    const events = new BullMqQueueEvents({
      connection: { host: 'redis', port: 6379 },
      queueEventsFactory: () => listener as unknown as QueueEvents,
    });

    const unsubscribe = events.listen('ai-image', { completed, progress });
    listener.emit('completed', { jobId: 'job-1', returnvalue: '{"ok":true}' });
    listener.emit('progress', { jobId: 'job-1', data: { stage: 'rendering' } });

    expect(completed).toHaveBeenCalledWith({
      queueName: 'ai-image',
      jobId: 'job-1',
      returnvalue: '{"ok":true}',
    });
    expect(progress).toHaveBeenCalledWith({
      queueName: 'ai-image',
      jobId: 'job-1',
      data: { stage: 'rendering' },
    });

    unsubscribe();
    listener.emit('completed', { jobId: 'job-2', returnvalue: '{}' });
    expect(completed).toHaveBeenCalledTimes(1);
  });

  it('reuses one blocking listener per queue and closes it once', async () => {
    const listener = createQueueEvents();
    const factory = vi.fn(() => listener as unknown as QueueEvents);
    const events = new BullMqQueueEvents({
      connection: { host: 'redis', port: 6379 },
      prefix: 'zucker',
      queueEventsFactory: factory,
    });

    events.listen('ai-text', { waiting: vi.fn() });
    events.listen('ai-text', { failed: vi.fn() });
    await events.waitUntilReady();
    await events.close();
    await events.close();

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith('ai-text', {
      connection: { host: 'redis', port: 6379 },
      prefix: 'zucker',
    });
    expect(listener.waitUntilReady).toHaveBeenCalledTimes(1);
    expect(listener.close).toHaveBeenCalledTimes(1);
  });
});
