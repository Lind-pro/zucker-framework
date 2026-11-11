import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DATABASE_ADAPTER, type DatabaseAdapter } from '@zucker-framework/core';
import { NotificationInbox, type NotificationInboxRepository, type NotificationInboxWhere } from '@zucker-framework/notification';
import { ApplicationDatabase, type ApplicationTransaction } from '../database';
import { validateInboxEmit, type InboxEmitInput, type InboxNotificationType } from './inbox-types';

/**
 * Injection token for the emitter (bound to InboxService). Other features keep their own optional
 * port and the integration module binds it to `InboxService.emit` (see `inbox-notifiers.ts`).
 */
export const INBOX_EMITTER = Symbol('INBOX_EMITTER');

/** User projection: no recipient id, event key or archive flag. */
export interface InboxNotificationView {
  id: string;
  type: InboxNotificationType | string;
  params: Record<string, unknown>;
  href: string | null;
  isRead: boolean;
  readAt: Date | null;
  createdAt: Date;
}
const VIEW_SELECT = Object.freeze({ id: true, type: true, params: true, href: true, isRead: true, readAt: true, createdAt: true });

/** `NotificationInboxRepository` over the `inboxNotifications` model; every call carries `userId`. */
export class InboxRepository implements NotificationInboxRepository<InboxNotificationView> {
  constructor(private readonly database: DatabaseAdapter) {}
  private get rows() { return this.database.model('inboxNotifications'); }
  async findMany(input: { where: NotificationInboxWhere; orderBy: { createdAt: 'desc' }; skip: number; take: number }) {
    // A stable tie-breaker keeps pages disjoint when several rows share one millisecond.
    return await this.rows.findMany({ where: input.where, orderBy: [input.orderBy, { id: 'desc' }], skip: input.skip, take: input.take,
      select: VIEW_SELECT }) as InboxNotificationView[];
  }
  count(input: { where: NotificationInboxWhere }) { return this.rows.count({ where: input.where }); }
  async findFirst(input: { where: NotificationInboxWhere }) {
    const finder = this.rows.findFirst;
    if (!finder) throw new Error('Database adapter must support findFirst');
    return await finder.call(this.rows, { where: input.where, select: VIEW_SELECT }) as InboxNotificationView | null;
  }
  async update(input: { where: { id: string; userId: string }; data: { isRead?: boolean; readAt?: Date; isArchived?: boolean } }) {
    return await this.rows.update({ where: input.where, data: input.data, select: VIEW_SELECT }) as InboxNotificationView;
  }
  updateMany(input: { where: NotificationInboxWhere; data: { isRead: true; readAt: Date } }) {
    return this.rows.updateMany({ where: input.where, data: input.data });
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PAGE_SIZE = 50;

function positiveInteger(value: unknown, fallback: number, max: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const parsed = typeof value === 'string' && /^\d{1,6}$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw new BadRequestException(`${name} must be an integer from 1 to ${max}`);
  return parsed;
}

/**
 * Recipient inbox (list, unread count, read, read-all, archive through the framework's
 * `NotificationInbox`) plus the one write path for new notifications, `emit`.
 */
@Injectable()
export class InboxService {
  private readonly inbox: NotificationInbox<InboxNotificationView>;
  constructor(@Inject(DATABASE_ADAPTER) private readonly database: ApplicationDatabase) {
    this.inbox = new NotificationInbox(new InboxRepository(database), { notFound: () => new NotFoundException('Notification not found') });
  }

  /** `GET /inbox` query: `page` (1..10000), `pageSize` (1..50, default 20), `unread=1|true` for unread only. */
  async list(userId: string, query: Record<string, unknown>) {
    const allowed = new Set(['page', 'pageSize', 'unread']);
    for (const key of Object.keys(query)) if (!allowed.has(key)) throw new BadRequestException(`Unknown query parameter ${key.slice(0, 64)}`);
    const unread = query.unread;
    if (unread !== undefined && !['1', '0', 'true', 'false'].includes(String(unread))) throw new BadRequestException('unread must be 1 or 0');
    return this.inbox.getUserNotifications(userId, positiveInteger(query.page, 1, 10_000, 'page'),
      positiveInteger(query.pageSize, 20, MAX_PAGE_SIZE, 'pageSize'), unread === '1' || unread === 'true');
  }

  async unreadCount(userId: string): Promise<{ unreadCount: number }> {
    return { unreadCount: await this.inbox.getUnreadCount(userId) };
  }

  /** Idempotent: reading a read notification keeps its first `readAt`. Another user's id is 404. */
  async markRead(userId: string, id: string): Promise<InboxNotificationView> {
    this.assertId(id);
    if (typeof userId !== 'string' || !userId) throw new NotFoundException('Notification not found');
    // Conditional write: only the first read sets readAt, so concurrent first reads agree on one value.
    return this.database.transaction(async tx => {
      await tx.query(`UPDATE inbox_notifications SET "isRead" = true, "readAt" = now()
        WHERE id = $1 AND "userId" = $2 AND "readAt" IS NULL`, [id, userId]);
      const row = await tx.model('inboxNotifications').findFirst!({ where: { id, userId }, select: VIEW_SELECT }) as InboxNotificationView | null;
      if (!row) throw new NotFoundException('Notification not found');
      return row;
    });
  }

  async markAllRead(userId: string): Promise<{ updated: number }> {
    return { updated: await this.inbox.markAllAsRead(userId) };
  }

  async archive(userId: string, id: string): Promise<{ archived: true }> {
    this.assertId(id);
    await this.inbox.archiveNotification(id, userId);
    return { archived: true };
  }

  /**
   * Records one notification. Pass the caller's transaction to commit it with the business change
   * (a rolled-back reply leaves no notification); `undefined` uses a short transaction of its own.
   * `INSERT … ON CONFLICT ("userId","eventKey") DO NOTHING`, so replays and concurrent emitters
   * yield at most one row; `created` is false for a repeat. Unknown or anonymised (`deleted-…`)
   * recipients are skipped, so late events cannot repopulate an erased account.
   * Throws `InboxEmitError` for an unknown type, non-allow-listed params or an unsafe href.
   */
  async emit(tx: ApplicationTransaction | undefined, input: InboxEmitInput): Promise<{ created: boolean }> {
    const value = validateInboxEmit(input);
    const write = async (transaction: ApplicationTransaction) => {
      const result = await transaction.query<{ id: string }>(`
        INSERT INTO inbox_notifications (id, "userId", "eventKey", type, params, href)
        SELECT $1, $2, $3, $4, $5::jsonb, $6
        WHERE EXISTS (SELECT 1 FROM users WHERE id = $2 AND username NOT LIKE 'deleted-%')
        ON CONFLICT ("userId", "eventKey") DO NOTHING
        RETURNING id`, [randomUUID(), value.userId, value.eventKey, value.type, JSON.stringify(value.params), value.href]);
      return { created: result.rows.length === 1 };
    };
    return tx ? write(tx) : this.database.transaction(write);
  }

  private assertId(id: string): void {
    // Malformed ids cannot exist; answer exactly like another user's id.
    if (typeof id !== 'string' || !UUID.test(id)) throw new NotFoundException('Notification not found');
  }
}
