"use client";
import { useMemo, useSyncExternalStore } from "react";

function takeFragmentTicket(key: string): string {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const ticket = fragment.get(key) || "";
  if (fragment.has(key)) {
    window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  }
  return /^[A-Za-z0-9_-]{43}$/.test(ticket) ? ticket : "";
}

/** Each mounted page captures its URL fragment once after hydration, including Strict Mode resubscriptions. */
function fragmentSource(key: string) {
  let ticket: string | null = null;
  return {
    getSnapshot: () => ticket,
    getServerSnapshot: () => null,
    subscribe: (notify: () => void) => {
      if (ticket === null) ticket = takeFragmentTicket(key);
      const changed = () => { ticket = takeFragmentTicket(key); notify(); };
      window.addEventListener("hashchange", changed);
      return () => window.removeEventListener("hashchange", changed);
    },
  };
}

/**
 * The one-time bearer stays in page memory, never in query strings or persistent storage.
 * `key` names the fragment parameter (`#ticket=…` by default; the login page reads `#cancel-deletion=…`).
 */
export function useEmailTicket(key = "ticket") {
  const source = useMemo(() => fragmentSource(key), [key]);
  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getServerSnapshot);
}
