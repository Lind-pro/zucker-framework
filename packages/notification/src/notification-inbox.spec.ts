import { describe, expect, it, vi } from 'vitest';
import { NotificationInbox, InboxNotificationNotFoundError } from './notification-inbox';

function fixture() {
  const record = { id: 'notice-1', userId: 'owner', isRead: false, isArchived: false };
  const repository = {
    findMany: vi.fn(async () => [record]),
    count: vi.fn(async () => 1),
    findFirst: vi.fn(async (): Promise<typeof record | null> => record),
    update: vi.fn(async () => record),
    updateMany: vi.fn(async () => ({ count: 2 })),
  };
  const now = new Date('2026-09-01T00:00:00Z');
  return { repository, record, now, inbox: new NotificationInbox(repository, { now: () => now }) };
}

describe('NotificationInbox', () => {
  it('scopes paginated rows, total and unread badge to the same recipient', async () => {
    const { inbox, repository, record } = fixture();
    await expect(inbox.getUserNotifications('owner', 2, 10)).resolves.toEqual({
      data: [record],
      total: 1,
      unreadCount: 1,
    });
    expect(repository.findMany).toHaveBeenCalledWith({
      where: { userId: 'owner', isArchived: false },
      orderBy: { createdAt: 'desc' },
      skip: 10,
      take: 10,
    });
    expect(repository.count).toHaveBeenNthCalledWith(1, {
      where: { userId: 'owner', isArchived: false },
    });
    expect(repository.count).toHaveBeenNthCalledWith(2, {
      where: { userId: 'owner', isRead: false, isArchived: false },
    });
    await inbox.getUserNotifications('owner', 1, 10, true);
    expect(repository.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { userId: 'owner', isArchived: false, isRead: false } }),
    );
  });

  it('checks ownership and keeps the recipient condition in read/archive writes', async () => {
    const { inbox, repository, now } = fixture();
    await inbox.markAsRead('notice-1', 'owner');
    expect(repository.findFirst).toHaveBeenCalledWith({
      where: { id: 'notice-1', userId: 'owner' },
    });
    expect(repository.update).toHaveBeenCalledWith({
      where: { id: 'notice-1', userId: 'owner' },
      data: { isRead: true, readAt: now },
    });
    await inbox.archiveNotification('notice-1', 'owner');
    expect(repository.update).toHaveBeenLastCalledWith({
      where: { id: 'notice-1', userId: 'owner' },
      data: { isArchived: true },
    });
  });

  it('does not mutate a missing/foreign notification and handles a stale pre-read', async () => {
    const { inbox, repository, record } = fixture();
    repository.findFirst.mockResolvedValueOnce(null);
    await expect(inbox.markAsRead('foreign', 'owner')).rejects.toBeInstanceOf(
      InboxNotificationNotFoundError,
    );
    expect(repository.update).not.toHaveBeenCalled();
    repository.findFirst.mockResolvedValueOnce(record);
    repository.update.mockRejectedValueOnce({ code: 'P2025' });
    await expect(inbox.archiveNotification('notice-1', 'owner')).rejects.toBeInstanceOf(
      InboxNotificationNotFoundError,
    );
  });

  it('marks all recipient unread records, including archived records, as before', async () => {
    const { inbox, repository, now } = fixture();
    await expect(inbox.markAllAsRead('owner')).resolves.toBe(2);
    expect(repository.updateMany).toHaveBeenCalledWith({
      where: { userId: 'owner', isRead: false },
      data: { isRead: true, readAt: now },
    });
  });

  it('fails before persistence when recipient scope or pagination is missing', async () => {
    const { inbox, repository } = fixture();
    expect(() => inbox.getUnreadCount(undefined as unknown as string)).toThrow(
      'recipient is required',
    );
    await expect(inbox.markAsRead('notice-1', '')).rejects.toThrow('recipient is required');
    await expect(inbox.getUserNotifications('owner', NaN, 20)).rejects.toThrow('positive integers');
    expect(repository.count).not.toHaveBeenCalled();
    expect(repository.findMany).not.toHaveBeenCalled();
    expect(repository.findFirst).not.toHaveBeenCalled();
  });
});
