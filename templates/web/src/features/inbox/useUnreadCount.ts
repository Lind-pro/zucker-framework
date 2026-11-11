'use client';
import { useCallback, useEffect, useState } from 'react';
import { CREDITS_CHANGED_EVENT } from '@/lib/site/credit-events';
import { inboxApi } from './api';
import { INBOX_CHANGED_EVENT, POLL_INTERVAL_MS, shouldPoll } from './inbox-state';

/**
 * Unread count for the header bell. Reads once when a session appears, then every 60 s while the
 * tab is visible (an interval is never kept for a hidden tab), on return to the tab, on
 * `CREDITS_CHANGED_EVENT` (a payment or AI charge often comes with a notification) and on
 * `INBOX_CHANGED_EVENT` from the notifications page. No server push.
 */
export function useUnreadCount(signedIn: boolean): number | null | undefined {
  const [count, setCount] = useState<number | null | undefined>(undefined);
  const refresh = useCallback(() => {
    inboxApi.unreadCount().then(setCount, () => setCount(null));
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };
    const sync = () => {
      stop();
      if (!shouldPoll({ signedIn, visibility: document.visibilityState })) return;
      refresh();
      timer = setInterval(() => {
        if (shouldPoll({ signedIn, visibility: document.visibilityState })) refresh();
        else stop();
      }, POLL_INTERVAL_MS);
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    window.addEventListener(CREDITS_CHANGED_EVENT, refresh);
    window.addEventListener(INBOX_CHANGED_EVENT, refresh);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener(CREDITS_CHANGED_EVENT, refresh);
      window.removeEventListener(INBOX_CHANGED_EVENT, refresh);
    };
  }, [signedIn, refresh]);

  return signedIn ? count : undefined;
}
