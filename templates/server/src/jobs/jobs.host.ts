import { HttpException, Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { FileAssetError, StorageTransferError } from '@zucker-framework/storage';
import { QuotaReservationError } from '@zucker-framework/credit';
import {
  DurableTaskAbortedError, DurableTaskNotClaimableError, DurableTaskRetryScheduledError,
  DurableWorkerRuntime, ExponentialTaskRetryPolicy, PostgresTaskOutboxRepository,
  SingleProcessTaskSupervisor, TaskLeaseReconciler, TaskOutboxDispatcher, TaskQueueReconciler,
} from '@zucker-framework/task';
import type { TaskErrorSummary } from '@zucker-framework/task';
import { DeliveryService } from '../delivery/delivery.service';
import { JobsService } from './jobs.service';
import { JOBS_OPTIONS, type JobsOptions } from './jobs.config';

function classify(error: unknown): TaskErrorSummary {
  if (error instanceof QuotaReservationError)
    return { code: 'JOB_QUOTA_INACTIVE', category: 'VALIDATION', retryable: false, summary: 'Reserved quota is no longer active' };
  if (error instanceof FileAssetError) {
    const retryable = ['CONTENT_UNAVAILABLE', 'UPLOAD_UNVERIFIED', 'DELETE_UNVERIFIED', 'METADATA_UNAVAILABLE', 'CONCURRENT_CHANGE', 'ASSET_NOT_READY'].includes(error.code);
    return { code: error.code, category: retryable ? 'INTERNAL' : 'VALIDATION', retryable, summary: error.code };
  }
  if (error instanceof StorageTransferError || (error instanceof HttpException && error.getStatus() < 500))
    return { code: 'JOB_INPUT_OR_STATE_INVALID', category: 'VALIDATION', retryable: false, summary: 'Job input or state is invalid' };
  return { code: 'JOB_EXECUTION_FAILED', category: 'INTERNAL', retryable: true, summary: 'The job step could not complete' };
}

@Injectable()
export class JobsHost implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(JobsHost.name);
  private readonly supervisor: SingleProcessTaskSupervisor;
  private readonly runtime: DurableWorkerRuntime;
  private readonly leases: TaskLeaseReconciler;
  private readonly outbox: TaskOutboxDispatcher;
  private readonly queue: TaskQueueReconciler;
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<unknown> }>();
  private scanWork?: Promise<readonly string[]>;
  private started = false;
  private stopping = false;
  private stopped?: Promise<void>;

  constructor(private readonly jobs: JobsService, private readonly delivery: DeliveryService,
    @Inject(JOBS_OPTIONS) private readonly options: JobsOptions) {
    this.runtime = new DurableWorkerRuntime({ repository: jobs.repository,
      resolveHandler: task => jobs.handler(task.kind, task.handlerVersion), retryPolicy: new ExponentialTaskRetryPolicy(),
      classifyError: classify, workerId: options.workerId, leaseDurationMs: options.leaseMs, heartbeatIntervalMs: options.heartbeatMs });
    this.leases = new TaskLeaseReconciler(jobs.repository);
    this.outbox = new TaskOutboxDispatcher(new PostgresTaskOutboxRepository(jobs.client), {
      publish: async message => this.supervisor.submit(`task:${message.taskId}`),
    }, { workerId: options.workerId, createLeaseToken: randomUUID });
    this.queue = new TaskQueueReconciler(jobs.repository, { ensure: async task => this.supervisor.submit(`task:${task.id}`) });
    this.supervisor = new SingleProcessTaskSupervisor({ concurrency: options.concurrency, scanIntervalMs: options.scanIntervalMs,
      loadPending: () => this.scan(), run: id => id === 'delivery:pump' ? this.runDelivery() : this.runTask(id.slice(5)).then(() => undefined),
      abort: id => this.abort(id === 'delivery:pump' ? id : id.slice(5)),
      onScanError: () => this.logger.warn('Durable runtime scan failed; persistent work is retained'),
      onExecutionError: (_id, error) => {
        if (!(error instanceof DurableTaskAbortedError || error instanceof DurableTaskRetryScheduledError || error instanceof DurableTaskNotClaimableError))
          this.logger.warn('Durable attempt did not complete; inspect its persistent status');
      },
    });
    jobs.attachHost({ wake: id => this.wake(id), abort: id => this.abort(id) });
  }
  async onApplicationBootstrap(): Promise<void> {
    if (this.started || this.stopping) return;
    this.started = true; this.jobs.sealRegistrations();
    if (this.options.enabled) await this.supervisor.onApplicationBootstrap();
  }
  wake(id: string): void {
    if (this.started && this.options.enabled && !this.stopping) this.supervisor.submit(`task:${id}`);
  }
  abort(id: string): void { this.active.get(id)?.controller.abort(); }

  /** The same attempt entry used by the supervisor and explicit worker integration tests. */
  runTask(id: string): Promise<unknown> {
    if (this.stopping) return Promise.reject(new DurableTaskAbortedError(id));
    const existing = this.active.get(id);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const promise = this.runtime.run(id, { signal: controller.signal }).finally(() => { this.active.delete(id); });
    this.active.set(id, { controller, promise });
    return promise;
  }
  private async runDelivery(): Promise<void> {
    if (this.stopping) return;
    const id = 'delivery:pump', controller = new AbortController();
    const promise = this.delivery.runOnce(`${this.options.workerId}:mail`, controller.signal).finally(() => { this.active.delete(id); });
    this.active.set(id, { controller, promise });
    await promise;
  }
  private scan(): Promise<readonly string[]> {
    const scan = (async () => {
      if (this.stopping) return [];
      for (const source of this.jobs.wakeSources()) {
        try { await source.runOnce(); }
        catch { this.logger.warn(`Durable wake source unavailable: ${source.name}`); }
        if (this.stopping) return [];
      }
      await this.leases.runOnce();
      if (this.stopping) return [];
      await this.outbox.runOnce();
      if (this.stopping) return [];
      await this.queue.runOnce();
      return this.delivery.isConfigured() && !this.stopping ? ['delivery:pump'] : [];
    })();
    this.scanWork = scan;
    return scan.finally(() => { if (this.scanWork === scan) this.scanWork = undefined; });
  }
  waitForIdle(): Promise<void> { return this.supervisor.waitForIdle(); }
  onModuleDestroy(): Promise<void> { return this.stop(); }
  stop(): Promise<void> {
    if (this.stopped) return this.stopped;
    this.stopping = true;
    return this.stopped = (async () => {
      await this.supervisor.onApplicationShutdown();
      for (const attempt of this.active.values()) attempt.controller.abort();
      const closingProvider = this.delivery.close();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const results = await Promise.race([
          Promise.allSettled([closingProvider, ...(this.scanWork ? [this.scanWork] : []), ...[...this.active.values()].map(value => value.promise)]),
          new Promise<never>((_done, reject) => { timer = setTimeout(() => reject(new Error('Durable runtime shutdown did not drain before its deadline')), this.options.shutdownWaitMs); }),
        ]);
        if (results[0]?.status === 'rejected') throw new Error('Durable email provider did not close cleanly');
      } finally { if (timer) clearTimeout(timer); }
    })();
  }
}
