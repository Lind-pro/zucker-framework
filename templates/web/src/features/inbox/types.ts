/** One row of `GET /inbox` (the server's user projection). Dates arrive as ISO strings. */
export interface InboxItem {
  id: string;
  type: string;
  params: Record<string, unknown>;
  href: string | null;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
}

export interface InboxPage {
  data: InboxItem[];
  total: number;
  unreadCount: number;
}
