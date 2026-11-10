import { MetadataScanner, Reflector, type DiscoveryService } from '@nestjs/core';
import type { BullMqWorkerHost, QueueWorkerDefinition } from './bullmq-worker-host';
import { QueueWorker } from './worker.decorator';
import { QueueWorkerExplorer } from './queue-worker.explorer';

class EmailConsumer {
  handled: unknown[] = [];

  @QueueWorker({ queue: 'emails', concurrency: 2 })
  async send(job: { data: unknown }) {
    this.handled.push(job.data);
    return 'sent';
  }

  notAWorker() {
    return 'noop';
  }
}

const discoveryWith = (...instances: object[]) =>
  ({
    getProviders: () => [
      ...instances.map((instance) => ({ instance, isNotMetatype: false })),
      { instance: undefined, isNotMetatype: false },
    ],
  }) as unknown as DiscoveryService;

describe('QueueWorkerExplorer', () => {
  it('registers @QueueWorker methods with the configured worker host', async () => {
    const consumer = new EmailConsumer();
    const registered: QueueWorkerDefinition[] = [];
    const host = {
      register: vi.fn((def: QueueWorkerDefinition) => registered.push(def)),
    } as unknown as BullMqWorkerHost;
    const explorer = new QueueWorkerExplorer(
      discoveryWith(consumer),
      new MetadataScanner(),
      new Reflector(),
      host,
    );
    explorer.onApplicationBootstrap();

    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({ queueName: 'emails', concurrency: 2 });
    await expect(registered[0].handler({ data: { to: 'a@example.test' } } as never)).resolves.toBe('sent');
    expect(consumer.handled).toEqual([{ to: 'a@example.test' }]);
  });

  it('reports decorated methods without a worker host instead of ignoring them silently', () => {
    const explorer = new QueueWorkerExplorer(
      discoveryWith(new EmailConsumer()),
      new MetadataScanner(),
      new Reflector(),
      null,
    );
    const warn = vi.spyOn((explorer as unknown as { logger: { warn: () => void } }).logger, 'warn')
      .mockImplementation(() => undefined);
    explorer.onApplicationBootstrap();
    expect(explorer.getDiscoveredWorkers()).toEqual([
      { queue: 'emails', concurrency: 2, target: 'EmailConsumer.send' },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('will not run'));
  });
});
