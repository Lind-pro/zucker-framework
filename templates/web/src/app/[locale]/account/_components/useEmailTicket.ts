"use client";
import { useMemo, useSyncExternalStore } from "react";

function takeFragmentTicket(): string {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const ticket = fragment.get("ticket") || "";
  if (fragment.has("ticket")) {
    window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  }
  return /^[A-Za-z0-9_-]{43}$/.test(ticket) ? ticket : "";
}

/** Each mounted page captures its URL fragment once after hydration, including Strict Mode resubscriptions. */
function fragmentSource() {
  let ticket: string | null = null;
  return {
    getSnapshot: () => ticket,
    getServerSnapshot: () => null,
    subscribe: (notify: () => void) => {
      if (ticket === null) ticket = takeFragmentTicket();
      const changed = () => { ticket = takeFragmentTicket(); notify(); };
      window.addEventListener("hashchange", changed);
      return () => window.removeEventListener("hashchange", changed);
    },
  };
}

/** The one-time bearer stays in page memory, never in query strings or persistent storage. */
export function useEmailTicket() {
  const source = useMemo(() => fragmentSource(), []);
  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getServerSnapshot);
}
