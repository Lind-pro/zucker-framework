'use client';
import { useState } from 'react';
import { useAuthHydrated } from '@/lib/site/session';
import { useAuthStore } from '@/lib/stores/auth-store';

/**
 * Key for per-account interactive pages (generator, chat, chat list). `null` until the persisted
 * session has hydrated: the page is not mounted before then, so it never fetches twice or loses a send
 * to a remount when auth loads. Afterwards the key changes only when a *different* known account
 * appears (a switch must not show the previous account's tasks or reuse its submit key); a user id
 * that arrives after hydration for the same session does not remount.
 */
export function useAccountScope(): string | null {
  const hydrated = useAuthHydrated();
  const id = useAuthStore((state) => (typeof state.user?.id === 'string' && state.user.id ? state.user.id : null));
  const [scope, setScope] = useState<{ key: string | null; known: string | null }>({ key: null, known: null });
  if (!hydrated) return null;
  let next = scope;
  if (next.key === null) next = { key: id ?? 'account', known: id };
  else if (id && id !== next.known) next = { key: next.known === null ? next.key : id, known: id };
  // Adjusting state while rendering (React's "store information from previous renders" pattern).
  if (next !== scope) setScope(next);
  return next.key;
}

/** Placeholder with the page's footprint while the session hydrates. */
export function AccountScopePending() {
  return <div className="min-h-[40vh]" aria-busy="true" />;
}
