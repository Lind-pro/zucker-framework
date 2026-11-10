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
    // Collect and validate everything first: registering starts workers, so a duplicate found
    // halfway through would otherwise leave earlier workers running after bootstrap failed.
    const found: Array<DiscoveredQueueWorker & { run: (job: QueueWorkerJob<unknown>) => Promise<unknown> }> = [];
    const seenInstances = new Map<object, Set<string>>();
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
        // The same instance reachable through several wrappers (aliases) is one worker.
        const methods = seenInstances.get(instance) ?? new Set<string>();
        if (methods.has(methodName)) continue;
        methods.add(methodName);
        seenInstances.set(instance, methods);
        const target = `${instance.constructor?.name ?? 'provider'}.${methodName}`;
        const existing = found.find((w) => w.queue === options.queue);
        if (existing) {
          const message =
            `Duplicate @QueueWorker("${options.queue}"): ${existing.target} and ${target}` +
            (existing.target === target ? ' (the provider is instantiated in more than one module)' : '') +
            '. Each queue may have one worker method.';
          // Without a worker host nothing runs (as before, only warn); with one it is fatal.
          if (!this.workerHost) {
            this.logger.warn(message);
            continue;
          }
          throw new Error(message);
        }
        found.push({
          queue: options.queue,
          concurrency: options.concurrency,
          target,
          run: (job) => (method as (job: QueueWorkerJob<unknown>) => Promise<unknown>).call(instance, job),
        });
      }
    }
    this.warnAboutControllers();

    for (const worker of found) {
      this.discovered.push({ queue: worker.queue, concurrency: worker.concurrency, target: worker.target });
      if (!this.workerHost) {
        this.logger.warn(
          `@QueueWorker("${worker.queue}") on ${worker.target} will not run: no BullMqWorkerHost configured (ZuckerQueueModule.forRoot({ workerHost })).`,
        );
        continue;
      }
      this.workerHost.register({
        queueName: worker.queue,
        concurrency: worker.concurrency,
        handler: worker.run,
      });
    }
  }

  /** `@QueueWorker` is only honoured on providers; say so instead of ignoring controller methods. */
  private warnAboutControllers(): void {
    const getControllers = (this.discoveryService as { getControllers?: () => Array<{ instance?: unknown }> })
      .getControllers;
    if (typeof getControllers !== 'function') return;
    for (const wrapper of getControllers.call(this.discoveryService)) {
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (!instance || typeof instance !== 'object') continue;
      const prototype = Object.getPrototypeOf(instance) as object | null;
      if (!prototype) continue;
      for (const methodName of this.metadataScanner.getAllMethodNames(prototype)) {
        const method = instance[methodName];
        if (typeof method !== 'function') continue;
        if (!this.reflector.get<QueueWorkerOptions | undefined>(QUEUE_WORKER_KEY, method)) continue;
        this.logger.warn(
          `@QueueWorker on controller method ${instance.constructor?.name ?? 'controller'}.${methodName} is ignored: move it to a provider.`,
        );
      }
    }
  }

  /** Decorated methods found during bootstrap (for diagnostics/tests). */
  getDiscoveredWorkers(): readonly DiscoveredQueueWorker[] {
    return [...this.discovered];
  }
}
