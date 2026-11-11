import type { InboxItem, InboxPage } from './types';

/**
 * Pure state for the notifications page and the polling rules of the header bell. No React or app
 * imports, so node tests can load it directly.
 */
export const INBOX_PAGE_SIZE = 20;
/** The bell refreshes this often, and only while the tab is visible and a session exists. */
export const POLL_INTERVAL_MS = 60_000;
/** Dispatched on `window` after the page changes read state, so the bell updates at once. */
export const INBOX_CHANGED_EVENT = 'zucker:inbox-changed';

export interface InboxState {
  status: 'loading' | 'ready' | 'failed';
  items: InboxItem[];
  total: number;
  unreadCount: number;
  page: number;
  unreadOnly: boolean;
}

export type InboxAction =
  | { type: 'load'; page: number; unreadOnly: boolean }
  | { type: 'loaded'; page: InboxPage }
  | { type: 'failed' }
  | { type: 'read'; id: string; readAt: string }
  | { type: 'readAll'; readAt: string }
  | { type: 'archived'; id: string };

export const initialInboxState: InboxState = { status: 'loading', items: [], total: 0, unreadCount: 0, page: 1, unreadOnly: false };

const count = (value: unknown) => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0);

export function inboxReducer(state: InboxState, action: InboxAction): InboxState {
  switch (action.type) {
    case 'load':
      return { ...state, status: 'loading', page: Math.max(1, Math.trunc(action.page) || 1), unreadOnly: action.unreadOnly };
    case 'loaded':
      return { ...state, status: 'ready', items: Array.isArray(action.page.data) ? action.page.data : [],
        total: count(action.page.total), unreadCount: count(action.page.unreadCount) };
    case 'failed':
      return { ...state, status: 'failed' };
    case 'read': {
      const target = state.items.find((item) => item.id === action.id);
      if (!target || target.isRead) return state;
      const items = state.unreadOnly
        ? state.items.filter((item) => item.id !== action.id)
        : state.items.map((item) => (item.id === action.id ? { ...item, isRead: true, readAt: action.readAt } : item));
      return { ...state, items, total: state.unreadOnly ? Math.max(0, state.total - 1) : state.total, unreadCount: Math.max(0, state.unreadCount - 1) };
    }
    case 'readAll':
      return { ...state, unreadCount: 0, items: state.unreadOnly ? [] : state.items.map((item) => (item.isRead ? item : { ...item, isRead: true, readAt: action.readAt })),
        total: state.unreadOnly ? 0 : state.total };
    case 'archived': {
      const target = state.items.find((item) => item.id === action.id);
      if (!target) return state;
      return { ...state, items: state.items.filter((item) => item.id !== action.id), total: Math.max(0, state.total - 1),
        unreadCount: target.isRead ? state.unreadCount : Math.max(0, state.unreadCount - 1) };
    }
    default:
      return state;
  }
}

export function pageCount(state: Pick<InboxState, 'total'>, pageSize = INBOX_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(state.total / pageSize));
}

/** The bell polls only for a signed-in session in a visible tab. */
export function shouldPoll(input: { signedIn: boolean; visibility: string | undefined }): boolean {
  return input.signedIn && input.visibility === 'visible';
}

/** Badge text; null hides the badge. */
export function badgeLabel(unread: number | null | undefined): string | null {
  if (typeof unread !== 'number' || !Number.isFinite(unread) || unread <= 0) return null;
  return unread > 99 ? '99+' : String(Math.trunc(unread));
}

/** Defence in depth: only a locale-free same-site path from the server becomes a link. */
export function safeHref(href: unknown): string | null {
  if (typeof href !== 'string' || href.length > 512 || !href.startsWith('/') || href.startsWith('//') || href.includes('\\')) return null;
  return /^\/[A-Za-z0-9\-._~/]*(?:\?[A-Za-z0-9\-._~=&%]*)?(?:#[A-Za-z0-9\-._~]*)?$/.test(href) ? href : null;
}
