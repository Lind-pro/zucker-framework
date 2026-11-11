import { httpClient } from '@/lib/http-client';
import { shellClient } from '@/lib/site/session';
import type { InboxItem, InboxPage } from './types';

const id = (value: string) => encodeURIComponent(value);
const quiet = { _hideError: true } as const;

export const inboxApi = {
  list: (query: { page: number; pageSize: number; unread?: boolean }) =>
    httpClient.get<InboxPage>('/inbox', { page: query.page, pageSize: query.pageSize, ...(query.unread ? { unread: 1 } : {}) }, quiet),
  read: (notificationId: string) => httpClient.post<InboxItem>(`/inbox/${id(notificationId)}/read`, {}, undefined, quiet),
  readAll: () => httpClient.post<{ updated: number }>('/inbox/read-all', {}, undefined, quiet),
  archive: (notificationId: string) => httpClient.post<{ archived: true }>(`/inbox/${id(notificationId)}/archive`, {}, undefined, quiet),
  /** Header bell: shell client, so an expired session on a public page clears state instead of redirecting. */
  unreadCount: async (): Promise<number | null> => {
    const result = await shellClient.get<{ unreadCount?: unknown }>('/inbox/unread-count', undefined, quiet);
    return typeof result?.unreadCount === 'number' && Number.isFinite(result.unreadCount) ? result.unreadCount : null;
  },
};
