import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import {
  DurableNotificationWorker, NotificationDeliveryError, NotificationIdempotencyConflictError, NotificationLeaseLostError,
  NotifyChannel, PostgresNotificationDeliveryRepository,
} from '@zucker-framework/notification';
import type { NotificationDeliveryHandler, NotificationSqlClient } from '@zucker-framework/notification';
import { createTaskFingerprint } from '@zucker-framework/task';
import { ApplicationDatabase, type ApplicationTransaction } from '../database';
import { HotProvider, hotProviderOf } from '@zucker-framework/back-office/settings';
import { DELIVERY_CONNECTION_PROFILE, DELIVERY_OPTIONS, MAX_DELIVERY_REPLAY_WINDOW_MS, type DeliveryOptions } from './delivery.config';

interface Message {
  id: string; ownerId: string; taskId: string | null; providerId: string; providerAccountScope: string;
  recipient: string; subject: string; text: string; dispatchStartedAt: Date | null;
}
export interface EnqueueOwnedMail {
  ownerId: string; idempotencyKey: string; taskId?: string; subject: string; text: string;
}

const configured = (options: DeliveryOptions) => !!options.accountScope && options.provider?.isConfigured() === true;

/**
 * Durable owned mail. The provider and account scope come from the hot `durable-email` profile
 * (`DELIVERY_OPTIONS` is a live view of `DELIVERY_CONNECTION`; a plain `DeliveryOptions` value is served unchanged): an
 * enqueue records the provider and scope current at that moment, a delivery leases the provider it
 * checked the row against for the whole send, and a message recorded under another provider or scope
 * is refused (`MAIL_PROFILE_MISMATCH`), exactly as after a restart. Lease and heartbeat timings and the
 * replay window are fixed at start-up (they are not part of the profile).
 */
@Injectable()
export class DeliveryService {
  readonly repository: PostgresNotificationDeliveryRepository;
  private readonly worker: DurableNotificationWorker;
  private readonly replayWindowMs: number;
  private readonly profile: HotProvider<DeliveryOptions>;
  private closed = false;
  private closePromise?: Promise<void>;
  constructor(@Inject(DATABASE_ADAPTER) private readonly database: ApplicationDatabase,
    @Inject(DELIVERY_OPTIONS) source: DeliveryOptions) {
    this.profile = hotProviderOf<DeliveryOptions>(source) ?? HotProvider.fixed<DeliveryOptions>(source, {
      name: 'Durable mail delivery', profiles: [DELIVERY_CONNECTION_PROFILE], dispose: options => options.provider?.close() });
    const options = this.profile.now();
    this.replayWindowMs = options.replayWindowMs ?? MAX_DELIVERY_REPLAY_WINDOW_MS;
    if (!Number.isSafeInteger(this.replayWindowMs) || this.replayWindowMs < 1 || this.replayWindowMs > MAX_DELIVERY_REPLAY_WINDOW_MS)
      throw new Error('Durable mail replay window must be positive and at most 23 hours');
    const client: NotificationSqlClient = { query: (sql, values) => database.transaction(tx => tx.query(sql, values)) };
    this.repository = new PostgresNotificationDeliveryRepository(client);
    this.worker = new DurableNotificationWorker(this.repository, { deliver: input => this.deliver(input) }, {
      leaseMs: options.leaseMs, heartbeatMs: options.heartbeatMs,
    });
  }
  /** Synchronous check against the newest resolved profile (a save is seen from the next check on). */
  isConfigured(): boolean {
    if (this.closed) return false;
    try { return configured(this.profile.now()); } catch { return false; }
  }
  assertConfigured(): void {
    if (!this.isConfigured()) throw new ServiceUnavailableException('Durable email delivery is not configured');
  }
  private async currentOptions(): Promise<DeliveryOptions> {
    const options = this.closed ? undefined : await this.profile.current().catch(() => undefined);
    if (!options || !configured(options)) throw new ServiceUnavailableException('Durable email delivery is not configured');
    return options;
  }
  async enqueueInTransaction(tx: ApplicationTransaction, input: EnqueueOwnedMail) {
    const options = await this.currentOptions();
    const command = structuredClone(input);
    if (!command.ownerId || !command.idempotencyKey.trim() || !command.subject.trim() || command.subject.length > 200
      || /[\r\n]/.test(command.subject) || !command.text.trim() || command.text.length > 4096)
      throw new Error('Invalid owned email request');
    const user = await tx.model('users').findUnique({ where: { id: command.ownerId }, select: { email: true, emailVerified: true, status: true } }) as
      { email: string | null; emailVerified: boolean; status: boolean } | null;
    if (!user?.status || !user.emailVerified || !user.email) throw new NotificationDeliveryError('Recipient is unavailable', 'MAIL_RECIPIENT_UNAVAILABLE', false);
    const id = `mail_${createHash('sha256').update(JSON.stringify([command.ownerId, command.idempotencyKey])).digest('hex')}`;
    const envelope = { ownerId: command.ownerId, taskId: command.taskId ?? null, providerId: options.provider!.name,
      providerAccountScope: options.accountScope, recipient: user.email, subject: command.subject, text: command.text };
    const fingerprint = createTaskFingerprint(envelope);
    await tx.query(`INSERT INTO delivery_messages ("id","ownerId","taskId","providerId","providerAccountScope","recipient","subject","text")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT ("id") DO NOTHING`,
    [id, envelope.ownerId, envelope.taskId, envelope.providerId, envelope.providerAccountScope, envelope.recipient, envelope.subject, envelope.text]);
    const stored = await tx.model('deliveryMessage').findUnique({ where: { id } }) as Message | null;
    if (!stored || createTaskFingerprint({ ownerId: stored.ownerId, taskId: stored.taskId, providerId: stored.providerId,
      providerAccountScope: stored.providerAccountScope, recipient: stored.recipient, subject: stored.subject, text: stored.text }) !== fingerprint)
      throw new NotificationIdempotencyConflictError(id);
    return new PostgresNotificationDeliveryRepository(tx).enqueue({ id, idempotencyKey: id,
      idempotencyFingerprint: fingerprint, channel: NotifyChannel.EMAIL, deliveryRef: id, maxAttempts: 3 });
  }
  enqueue(input: EnqueueOwnedMail) { return this.database.transaction(tx => this.enqueueInTransaction(tx, input)); }

  async runOnce(workerId: string, signal?: AbortSignal) {
    if (this.closed || !configured(await this.profile.current().catch(() => ({ accountScope: '' } as DeliveryOptions))))
      return { kind: 'unconfigured' as const };
    return this.worker.runOnce({ workerId, signal });
  }

  private async deliver(input: Parameters<NotificationDeliveryHandler['deliver']>[0]): Promise<{ providerMessageId?: string }> {
    if (input.signal?.aborted) throw new NotificationDeliveryError('Delivery interrupted', 'MAIL_WORKER_ABORTED', true);
    // The provider is leased for the whole delivery: a profile save while it runs does not close it.
    return this.profile.use(options => this.deliverWith(options, input));
  }
  private async deliverWith(options: DeliveryOptions, input: Parameters<NotificationDeliveryHandler['deliver']>[0]): Promise<{ providerMessageId?: string }> {
    if (this.closed || !configured(options)) throw new ServiceUnavailableException('Durable email delivery is not configured');
    const provider = options.provider!;
    // The durable claim and the non-idempotent dispatch marker are checked together.
    // A provider call can outlive a lease, so SMTP never automatically crosses this marker twice.
    const message = await this.database.transaction(async tx => {
      const active = await tx.query<{ id: string }>(`SELECT "id" FROM notification_deliveries
        WHERE "id"=$1 AND "deliveryRef"=$1 AND "status"='PROCESSING' AND "attempt"=$2 AND "leaseExpiresAt">$3 FOR UPDATE`,
      [input.deliveryRef, input.attempt, new Date()]);
      if (!active.rows[0]) throw new NotificationLeaseLostError(input.deliveryRef);
      const row = await tx.model('deliveryMessage').findUnique({ where: { id: input.deliveryRef } }) as Message | null;
      if (!row || input.channel !== NotifyChannel.EMAIL || row.providerId !== provider.name || row.providerAccountScope !== options.accountScope)
        throw new NotificationDeliveryError('Delivery profile changed', 'MAIL_PROFILE_MISMATCH', false);
      const owner = await tx.model('users').findUnique({ where: { id: row.ownerId }, select: { status: true, emailVerified: true, email: true } }) as
        { status: boolean; emailVerified: boolean; email: string | null } | null;
      if (!owner?.status || !owner.emailVerified || owner.email !== row.recipient)
        throw new NotificationDeliveryError('Recipient changed', 'MAIL_RECIPIENT_UNAVAILABLE', false);
      if (!provider.supportsIdempotency && row.dispatchStartedAt)
        throw new NotificationDeliveryError('Previous delivery outcome requires review', 'MAIL_OUTCOME_UNKNOWN', false);
      if (row.dispatchStartedAt && (Date.now() - row.dispatchStartedAt.getTime() >= this.replayWindowMs
        || row.dispatchStartedAt.getTime() > Date.now()))
        throw new NotificationDeliveryError('Provider idempotency replay window requires review', 'MAIL_IDEMPOTENCY_WINDOW_EXPIRED', false);
      if (!row.dispatchStartedAt) await tx.model('deliveryMessage').update({ where: { id: row.id }, data: { dispatchStartedAt: new Date() } });
      return row;
    });
    if (input.signal?.aborted) throw new NotificationDeliveryError('Delivery interrupted', 'MAIL_WORKER_ABORTED', true);
    try {
      const result = await provider.deliver({ to: message.recipient, subject: message.subject, text: message.text }, {
        signal: input.signal, ...(provider.supportsIdempotency ? { idempotencyKey: input.idempotencyKey } : {}),
      });
      if (result.success) return { providerMessageId: result.messageId };
    } catch { /* The provider outcome is intentionally represented by a safe code below. */ }
    throw new NotificationDeliveryError('Mail provider did not confirm delivery',
      provider.supportsIdempotency ? 'MAIL_PROVIDER_UNAVAILABLE' : 'MAIL_OUTCOME_UNKNOWN', provider.supportsIdempotency);
  }

  async getOwned(ownerId: string, id: string) {
    const messages = await this.database.model('deliveryMessage').findMany({ where: { id, ownerId }, take: 1 }) as Message[];
    if (!messages[0]) throw new NotFoundException();
    const delivery = await this.repository.getById(id);
    if (!delivery) throw new NotFoundException();
    return { id: delivery.id, status: delivery.status, attempt: delivery.attempt, maxAttempts: delivery.maxAttempts,
      errorCode: delivery.errorCode, createdAt: delivery.createdAt, deliveredAt: delivery.deliveredAt,
      requiresReview: !!messages[0].dispatchStartedAt && delivery.status !== 'DELIVERED'
        && (delivery.errorCode === 'MAIL_OUTCOME_UNKNOWN' || delivery.status === 'DEAD') };
  }
  async forTask(ownerId: string, taskId: string) {
    const messages = await this.database.model('deliveryMessage').findMany({ where: { taskId, ownerId }, select: { id: true }, take: 1 }) as Array<{ id: string }>;
    if (!messages[0]) throw new NotFoundException();
    return this.getOwned(ownerId, messages[0].id);
  }
  /** One host owns provider closure, after interrupting active delivery work (a leased provider closes when released). */
  close(): Promise<void> {
    this.closed = true;
    return this.closePromise ??= this.profile.close();
  }
}
