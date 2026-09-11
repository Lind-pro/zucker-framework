import { useSyncExternalStore } from 'react';

/** The persistence capabilities needed to observe authentication hydration. */
export interface AuthHydrationStore {
  persist?: {
    hasHydrated: () => boolean;
    onFinishHydration: (listener: () => void) => () => void;
  };
}

/**
 * Bind a hydration hook to an auth store. The server snapshot is always false,
 * keeping the initial server/client render aligned until browser state is read.
 */
export function createUseAuthHydration(store: AuthHydrationStore) {
  const subscribe = (listener: () => void) =>
    store.persist?.onFinishHydration(listener) ?? (() => undefined);
  const getSnapshot = () => store.persist?.hasHydrated() ?? false;
  const getServerSnapshot = () => false;

  return function useAuthHydration(): boolean {
    return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  };
}
