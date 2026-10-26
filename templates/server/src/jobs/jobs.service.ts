import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import {
  createTaskFingerprint, PostgresTaskRepository, PostgresTaskSubmitter, PostgresTaskSummaryReader, TaskIdempotencyConflictError,
} from '@zucker-framework/task';
import type { CreateTaskInput, PostgresTaskClient, TaskRecord } from '@zucker-framework/task';
import { ApplicationDatabase, type ApplicationTransaction } from '../database';
import type { ApplicationJobCommand, ApplicationJobRegistration, ApplicationJobSubmission, ApplicationJobTransactionHooks, ApplicationJobWakeSource } from './jobs.types';

@Injectable()
export class JobsService {
  readonly client: PostgresTaskClient;
  readonly repository: PostgresTaskRepository;
  private readonly reader: PostgresTaskSummaryReader;
  private readonly handlers = new Map<string, ApplicationJobRegistration>();
  private readonly sources = new Map<string, ApplicationJobWakeSource>();
  private readonly transactionHooks = new Map<string, ApplicationJobTransactionHooks>();
  private sealed = false;
  private host?: { wake(id: string): void; abort(id: string): void };

  constructor(@Inject(DATABASE_ADAPTER) readonly database: ApplicationDatabase) {
    this.client = { query: (sql, values) => database.transaction(tx => tx.query(sql, values)) };
    this.repository = new PostgresTaskRepository(this.client);
    this.reader = new PostgresTaskSummaryReader(this.client);
  }
  registerHandler(registration: ApplicationJobRegistration): void {
    if (this.sealed || !/^[a-z][a-z0-9.-]{0,79}$/.test(registration.kind) || !registration.version.trim()
      || this.handlers.has(registration.kind) || !Number.isSafeInteger(registration.maxAttempts ?? 3)
      || (registration.maxAttempts ?? 3) < 1 || (registration.maxAttempts ?? 3) > 10) throw new Error('Invalid or duplicate job registration');
    this.handlers.set(registration.kind, Object.freeze({ ...registration }));
  }
  registerWakeSource(source: ApplicationJobWakeSource): void {
    if (this.sealed || !source.name.trim() || typeof source.runOnce !== 'function' || this.sources.has(source.name))
      throw new Error('Invalid or duplicate job wake source');
    this.sources.set(source.name, Object.freeze({ name: source.name, runOnce: source.runOnce.bind(source) }));
  }
  registerTransactionHooks(hooks: ApplicationJobTransactionHooks): void {
    if (this.sealed || !hooks.name.trim() || !hooks.kind.trim() || this.transactionHooks.has(hooks.name))
      throw new Error('Invalid or duplicate job transaction hooks');
    this.transactionHooks.set(hooks.name, Object.freeze({ name: hooks.name, kind: hooks.kind,
      submitted: hooks.submitted?.bind(hooks), completed: hooks.completed?.bind(hooks),
      cancelled: hooks.cancelled?.bind(hooks), failed: hooks.failed?.bind(hooks) }));
  }
  async applyTransactionHooks(phase: 'submitted' | 'completed' | 'cancelled' | 'failed', tx: ApplicationTransaction, task: TaskRecord): Promise<void> {
    for (const hooks of this.transactionHooks.values()) if (hooks.kind === task.kind) await hooks[phase]?.(tx, task);
  }
  registrations() { return [...this.handlers.values()]; }
  wakeSources() { return [...this.sources.values()]; }
  handler(kind: string, version: string) {
    const registration = this.handlers.get(kind);
    return registration?.version === version ? registration.handler : undefined;
  }
  attachHost(host: { wake(id: string): void; abort(id: string): void }): void {
    if (this.host) throw new Error('Jobs host is already attached');
    this.host = host;
  }
  sealRegistrations(): void { this.sealed = true; }
  /** In-memory hint only; queued PG tasks/outbox repair missed or early hints. */
  wake(taskId: string): void { this.host?.wake(taskId); }

  private identity(kind: string, ownerId: string | undefined, key: string) {
    if (typeof key !== 'string' || !key.trim() || key.length > 300) throw new BadRequestException('Invalid job idempotency key');
    const hash = createHash('sha256').update(JSON.stringify([kind, ownerId ?? null, key])).digest('hex');
    return { id: `job_${hash}`, key: `job:${hash}` };
  }
  private prepare(input: ApplicationJobCommand): CreateTaskInput<unknown> {
    // Snapshot caller-owned data before any async transaction/authorization boundary.
    const command = structuredClone(input);
    const registration = this.handlers.get(command.kind);
    if (!registration) throw new BadRequestException('Unsupported job kind');
    const identity = this.identity(command.kind, command.ownerId, command.idempotencyKey);
    if (typeof command.resource?.type !== 'string' || !command.resource.type.trim()
      || typeof command.resource.id !== 'string' || !command.resource.id.trim()) throw new BadRequestException('Invalid job resource');
    if (command.ownerId !== undefined && (typeof command.ownerId !== 'string' || !command.ownerId.trim()))
      throw new BadRequestException('Invalid job owner');
    if (command.availableAt && (!(command.availableAt instanceof Date) || !Number.isFinite(command.availableAt.getTime())))
      throw new BadRequestException('Invalid job availability');
    const fingerprint = createTaskFingerprint({ kind: command.kind, ownerId: command.ownerId ?? null,
      orderId: command.orderId ?? null, resource: command.resource, payload: command.payload,
      handlerVersion: registration.version, availableAt: command.availableAt ?? null, maxAttempts: registration.maxAttempts ?? 3 });
    return { id: identity.id, kind: command.kind, userId: command.ownerId, orderId: command.orderId,
      resource: command.resource, idempotencyKey: identity.key, idempotencyFingerprint: fingerprint,
      handlerVersion: registration.version, payload: command.payload, maxAttempts: registration.maxAttempts ?? 3,
      availableAt: command.availableAt, now: new Date() };
  }
  async submitInTransaction(tx: ApplicationTransaction, command: ApplicationJobCommand): Promise<ApplicationJobSubmission> {
    const prepared = this.prepare(command);
    const submitter = new PostgresTaskSubmitter({ runInTransaction: work => work(tx) });
    const result = await submitter.submit({ task: prepared, outbox: {
      id: `wake:${prepared.id}`, topic: 'application.job.ready', payload: { taskId: prepared.id }, availableAt: prepared.availableAt,
    } });
    if (result.task.created) await this.applyTransactionHooks('submitted', tx, result.task.task);
    return result.task;
  }
  async submit(command: ApplicationJobCommand): Promise<ApplicationJobSubmission> {
    const snapshot = structuredClone(command);
    const result = await this.database.transaction(tx => this.submitInTransaction(tx, snapshot));
    this.wake(result.task.id);
    return result;
  }
  async submitForUser(ownerId: string, key: string | undefined, input: unknown) {
    if (!key || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new BadRequestException('A stable Idempotency-Key is required');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException('Invalid job request');
    const body = structuredClone(input) as Record<string, unknown>;
    if (Object.keys(body).some(name => name !== 'kind' && name !== 'input') || typeof body.kind !== 'string')
      throw new BadRequestException('Invalid job request');
    const kind = body.kind, identity = this.identity(kind, ownerId, key), registration = this.handlers.get(kind);
    if (!registration?.parseUserInput) throw new BadRequestException('Job kind is not available for user submission');
    const parsed = await registration.parseUserInput(Object.freeze({ ownerId, taskId: identity.id }), body.input);
    try {
      const result = await this.submit({ kind, idempotencyKey: key, ownerId, resource: parsed.resource, payload: parsed.payload });
      return await this.get(ownerId, result.task.id);
    } catch (error) {
      if (error instanceof TaskIdempotencyConflictError) throw new ConflictException('Job request key was reused with different content');
      throw error;
    }
  }
  async get(ownerId: string, id: string) {
    const summary = await this.reader.findOwnedById(id, ownerId);
    if (!summary) throw new NotFoundException();
    return { ...summary, canCancel: this.canCancel(summary) };
  }
  async list(ownerId: string) { return (await this.reader.listOwned({ userId: ownerId })).map(task => ({ ...task, canCancel: this.canCancel(task) })); }
  private canCancel(task: { kind: string; status: string }): boolean {
    return !!this.handlers.get(task.kind)?.parseUserInput && ['QUEUED', 'PROCESSING', 'WAITING_PROVIDER', 'RETRYING'].includes(task.status);
  }
  async cancel(ownerId: string, id: string) {
    await this.database.transaction(async tx => {
      const task = await new PostgresTaskSummaryReader(tx).findOwnedById(id, ownerId);
      if (!task) throw new NotFoundException();
      if (!this.handlers.get(task.kind)?.parseUserInput) throw new BadRequestException('This task is maintained by the server');
      const cancelled = await new PostgresTaskRepository(tx).cancel(id, new Date());
      if (cancelled) await this.applyTransactionHooks('cancelled', tx, cancelled);
    });
    this.host?.abort(id);
    return this.get(ownerId, id);
  }
  async record(ownerId: string, id: string) {
    await this.get(ownerId, id);
    const rows = await this.database.model('jobRecord').findMany({ where: { taskId: id, ownerId }, take: 1 }) as Array<{ value: string; createdAt: Date }>;
    if (!rows[0]) throw new NotFoundException();
    return { value: rows[0].value, createdAt: rows[0].createdAt };
  }
}
