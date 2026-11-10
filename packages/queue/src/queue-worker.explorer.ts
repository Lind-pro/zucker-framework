import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import type { BullMqWorkerHost, QueueWorkerJob } from './bullmq-worker-host';
import { QUEUE_WORKER_KEY, type QueueWorkerOptions } from './worker.decorator';

/** Injection token for the BullMqWorkerHost that runs `@QueueWorker` methods. */
export const QUEUE_WORKER_HOST = Symbol('ZUCKER_QUEUE_WORKER_HOST');

export interface DiscoveredQueueWorker {
  queue: string;
  concurrency?: number;
  target: string;
}

/**
 * Discovers provider methods decorated with `@QueueWorker` and registers them
 * with the configured {@link BullMqWorkerHost} at application bootstrap.
 *
 * Without a worker host the decorated methods cannot run; the explorer logs a
 * warning for each one instead of silently ignoring them.
 */
@Injectable()
export class QueueWorkerExplorer implements OnApplicationBootstrap {
  private readonly logger = new Logger(QueueWorkerExplorer.name);
  private readonly discovered: DiscoveredQueueWorker[] = [];

  constructor(
    private readonly discoveryService: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
    private readonly reflector: Reflector,
    @Optional() @Inject(QUEUE_WORKER_HOST) private readonly workerHost?: BullMqWorkerHost | null,
  ) {}

  onApplicationBootstrap(): void {
    for (const wrapper of this.discoveryService.getProviders()) {
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (!instance || typeof instance !== 'object' || wrapper.isNotMetatype) continue;
      const prototype = Object.getPrototypeOf(instance) as object | null;
      if (!prototype) continue;
      for (const methodName of this.metadataScanner.getAllMethodNames(prototype)) {
        const method = instance[methodName];
        if (typeof method !== 'function') continue;
        const options = this.reflector.get<QueueWorkerOptions | undefined>(QUEUE_WORKER_KEY, method);
        if (!options) continue;
        const target = `${instance.constructor?.name ?? 'provider'}.${methodName}`;
        this.discovered.push({ queue: options.queue, concurrency: options.concurrency, target });
        if (!this.workerHost) {
          this.logger.warn(
            `@QueueWorker("${options.queue}") on ${target} will not run: no BullMqWorkerHost configured (ZuckerQueueModule.forRoot({ workerHost })).`,
          );
          continue;
        }
        this.workerHost.register({
          queueName: options.queue,
          concurrency: options.concurrency,
          handler: (job: QueueWorkerJob<unknown>) =>
            (method as (job: QueueWorkerJob<unknown>) => Promise<unknown>).call(instance, job),
        });
      }
    }
  }

  /** Decorated methods found during bootstrap (for diagnostics/tests). */
  getDiscoveredWorkers(): readonly DiscoveredQueueWorker[] {
    return [...this.discovered];
  }
}
