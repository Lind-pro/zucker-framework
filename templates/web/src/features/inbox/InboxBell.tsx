'use client';
import { Bell } from 'lucide-react';
import { useLocale } from 'next-intl';
import { AccountLink } from '@/components/AccountLink';
import { useAuthHydrated } from '@/lib/site/session';
import { useAuthStore } from '@/lib/stores/auth-store';
import { inboxCopy } from './copy';
import { badgeLabel } from './inbox-state';
import { useUnreadCount } from './useUnreadCount';

/**
 * Header bell with the unread badge, linking to /account/notifications. Renders nothing until the
 * persisted session is hydrated and present, so cached public HTML never depends on a session.
 */
export function InboxBell() {
  const text = inboxCopy(useLocale());
  const hydrated = useAuthHydrated();
  const authenticated = useAuthStore((state) => state.isAuthenticated && Boolean(state.token));
  const signedIn = hydrated && authenticated;
  const unread = useUnreadCount(signedIn);
  if (!signedIn) return null;
  const badge = badgeLabel(unread);
  return (
    <AccountLink
      href="/account/notifications"
      aria-label={text.bell(typeof unread === 'number' ? unread : 0)}
      className="relative inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-card)]"
      data-testid="inbox-bell"
    >
      <Bell size={16} aria-hidden />
      {badge && (
        <span
          className="absolute -right-1.5 -top-1.5 min-w-[1.25rem] rounded-full bg-primary-600 px-1 text-center text-[11px] font-semibold leading-5 text-white tabular-nums"
          data-testid="inbox-unread-badge"
        >
          {badge}
        </span>
      )}
    </AccountLink>
  );
}

export default InboxBell;
