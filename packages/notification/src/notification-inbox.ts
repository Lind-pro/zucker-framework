export interface NotificationInboxWhere {
  userId: string;
  id?: string;
  isRead?: boolean;
  isArchived?: boolean;
}

/** Minimal durable delegate; queries and writes always carry the recipient scope. */
export interface NotificationInboxRepository<T> {
  findMany(input: {
    where: NotificationInboxWhere;
    orderBy: { createdAt: 'desc' };
    skip: number;
    take: number;
  }): Promise<T[]>;
  count(input: { where: NotificationInboxWhere }): Promise<number>;
  findFirst(input: { where: NotificationInboxWhere }): Promise<T | null>;
  update(input: {
    where: { id: string; userId: string };
    data: { isRead?: boolean; readAt?: Date; isArchived?: boolean };
  }): Promise<T>;
  updateMany(input: {
    where: NotificationInboxWhere;
    data: { isRead: true; readAt: Date };
  }): Promise<{ count: number }>;
}

export interface NotificationInboxOptions {
  notFound?: () => Error;
  now?: () => Date;
}

export class InboxNotificationNotFoundError extends Error {
  constructor() {
    super('Notification not found');
    this.name = 'InboxNotificationNotFoundError';
  }
}

/**
 * Durable recipient inbox behavior. Preference evaluation, notification types,
 * creation, expiry policy and administrative operations belong to the consumer.
 * Bulk read includes archived unread records; lists/unread badges exclude them.
 */
export class NotificationInbox<T> {
  constructor(
    private readonly inboxRepository: NotificationInboxRepository<T>,
    private readonly inboxOptions: NotificationInboxOptions = {},
  ) {}

  async getUserNotifications(
    userId: string,
    page = 1,
    pageSize = 20,
    unreadOnly = false,
  ): Promise<{ data: T[]; total: number; unreadCount: number }> {
    this.requireRecipient(userId);
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1)
      throw new RangeError('Inbox pagination must use positive integers');
    const where: NotificationInboxWhere = { userId, isArchived: false };
    if (unreadOnly) where.isRead = false;
    const [data, total, unreadCount] = await Promise.all([
      this.inboxRepository.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.inboxRepository.count({ where }),
      this.getUnreadCount(userId),
    ]);
    return { data, total, unreadCount };
  }

  getUnreadCount(userId: string): Promise<number> {
    this.requireRecipient(userId);
    return this.inboxRepository.count({ where: { userId, isRead: false, isArchived: false } });
  }

  markAsRead(notificationId: string, userId: string): Promise<T> {
    return this.updateOwned(notificationId, userId, { isRead: true, readAt: this.now() });
  }

  async markAllAsRead(userId: string): Promise<number> {
    this.requireRecipient(userId);
    const result = await this.inboxRepository.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true, readAt: this.now() },
    });
    return result.count;
  }

  async archiveNotification(notificationId: string, userId: string): Promise<void> {
    await this.updateOwned(notificationId, userId, { isArchived: true });
  }

  private requireRecipient(userId: string): void {
    if (typeof userId !== 'string' || !userId)
      throw new TypeError('A notification recipient is required');
  }

  private now(): Date {
    return this.inboxOptions.now?.() ?? new Date();
  }
  private notFound(): Error {
    return this.inboxOptions.notFound?.() ?? new InboxNotificationNotFoundError();
  }

  private async updateOwned(
    id: string,
    userId: string,
    data: { isRead?: boolean; readAt?: Date; isArchived?: boolean },
  ): Promise<T> {
    this.requireRecipient(userId);
    const record = await this.inboxRepository.findFirst({ where: { id, userId } });
    if (!record) throw this.notFound();
    try {
      // Keep scope in the write too: a stale pre-read is not authorization.
      return await this.inboxRepository.update({ where: { id, userId }, data });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2025')
        throw this.notFound();
      throw error;
    }
  }
}
