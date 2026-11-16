import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import InboxPage from '../src/features/inbox/InboxPage';
import { inboxApi } from '../src/features/inbox/api';

vi.mock('next-intl', () => ({ useLocale: () => 'en', useTranslations: () => (key: string) => key }));
vi.mock('@/i18n/navigation', () => ({ Link: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a> }));
vi.mock('@/features/ai/useAccountScope', () => ({ useAccountScope: () => 'alice' }));
vi.mock('../src/features/inbox/api', () => ({ inboxApi: { list: vi.fn(), read: vi.fn(), archive: vi.fn(), readAll: vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const item = (index: number) => ({ id: `n${index}`, type: 'order.paid', params: { credits: index }, href: null,
  isRead: false, readAt: null, createdAt: '2026-11-10T00:00:00Z' });

it('returns from page two to the remaining unread notifications after marking its sole row read', async () => {
  let total = 21;
  vi.mocked(inboxApi.list).mockImplementation(async query => ({
    data: query.page === 2 ? [item(21)] : Array.from({ length: 20 }, (_, i) => item(i + 1)), total, unreadCount: total,
  }));
  vi.mocked(inboxApi.read).mockImplementation(async () => { total = 20; return { ...item(21), isRead: true, readAt: '2026-11-11T00:00:00Z' }; });
  render(<InboxPage />);
  await screen.findByTestId('inbox-list');
  fireEvent.click(screen.getByRole('button', { name: /^Unread \(/ }));
  await waitFor(() => expect(inboxApi.list).toHaveBeenLastCalledWith({ page: 1, pageSize: 20, unread: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  await waitFor(() => expect(within(screen.getByTestId('inbox-list')).getAllByRole('listitem')).toHaveLength(1));
  fireEvent.click(screen.getByRole('button', { name: 'Mark as read' }));
  await waitFor(() => expect(inboxApi.list).toHaveBeenLastCalledWith({ page: 1, pageSize: 20, unread: true }));
  await waitFor(() => expect(within(screen.getByTestId('inbox-list')).getAllByRole('listitem')).toHaveLength(20));
  expect(screen.queryByText('No unread notifications.')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Previous' })).toBeNull();
});
