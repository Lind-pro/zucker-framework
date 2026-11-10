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

  describe('duplicates and controllers (L6)', () => {
    class SecondEmailConsumer {
      @QueueWorker({ queue: 'emails' })
      async deliver() {
        return 'second';
      }
    }

    // Same class instantiated twice (a provider declared in two modules).
    const hostWith = () => {
      const register = vi.fn();
      return { host: { register } as unknown as BullMqWorkerHost, register };
    };

    it('a duplicate queue with a host gives one descriptive error and zero register calls', () => {
      const { host, register } = hostWith();
      const explorer = new QueueWorkerExplorer(
        discoveryWith(new EmailConsumer(), new SecondEmailConsumer()),
        new MetadataScanner(),
        new Reflector(),
        host,
      );
      expect(() => explorer.onApplicationBootstrap()).toThrow(
        /Duplicate @QueueWorker\("emails"\).*EmailConsumer\.send.*SecondEmailConsumer\.deliver/,
      );
      expect(register).not.toHaveBeenCalled();
    });

    it('the same provider class instantiated twice is reported as such, still with zero registrations', () => {
      const { host, register } = hostWith();
      const explorer = new QueueWorkerExplorer(
        discoveryWith(new EmailConsumer(), new EmailConsumer()),
        new MetadataScanner(),
        new Reflector(),
        host,
      );
      expect(() => explorer.onApplicationBootstrap()).toThrow(/more than one module/);
      expect(register).not.toHaveBeenCalled();
    });

    it('a duplicate earlier than a valid worker does not leave the valid one registered', () => {
      class Other {
        @QueueWorker({ queue: 'reports' })
        async run() {
          return 1;
        }
      }
      const { host, register } = hostWith();
      const explorer = new QueueWorkerExplorer(
        discoveryWith(new Other(), new EmailConsumer(), new SecondEmailConsumer()),
        new MetadataScanner(),
        new Reflector(),
        host,
      );
      expect(() => explorer.onApplicationBootstrap()).toThrow();
      expect(register).not.toHaveBeenCalled();
    });

    it('without a worker host a duplicate only warns', () => {
      const explorer = new QueueWorkerExplorer(
        discoveryWith(new EmailConsumer(), new SecondEmailConsumer()),
        new MetadataScanner(),
        new Reflector(),
        null,
      );
      const warn = vi.spyOn((explorer as unknown as { logger: { warn: () => void } }).logger, 'warn')
        .mockImplementation(() => undefined);
      expect(() => explorer.onApplicationBootstrap()).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Duplicate @QueueWorker("emails")'));
    });

    it('a decorated controller method warns that it is ignored', () => {
      class EmailController {
        @QueueWorker({ queue: 'from-controller' })
        async handle() {
          return 1;
        }
      }
      const discovery = {
        getProviders: () => [],
        getControllers: () => [{ instance: new EmailController() }],
      } as unknown as DiscoveryService;
      const { host, register } = hostWith();
      const explorer = new QueueWorkerExplorer(discovery, new MetadataScanner(), new Reflector(), host);
      const warn = vi.spyOn((explorer as unknown as { logger: { warn: () => void } }).logger, 'warn')
        .mockImplementation(() => undefined);
      explorer.onApplicationBootstrap();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('EmailController.handle'));
      expect(register).not.toHaveBeenCalled();
    });
  });
});
