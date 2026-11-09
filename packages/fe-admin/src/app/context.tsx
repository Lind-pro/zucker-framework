import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useAdminI18n } from '../i18n/context';
import { isAbortError } from '../lib/format';
import { pageTitle } from './menu';
import type { AdminPageDefinition, ResolvedAdminConfig } from './config';
import type { AdminApi, AdminSession, AdminUser, RestoreResult } from './session';

export type SessionStatus = 'ready' | 'restoring' | 'failed';

export interface AdminContextValue {
  config: ResolvedAdminConfig;
  session: AdminSession;
  pages: readonly AdminPageDefinition[];
  sessionStatus: SessionStatus;
  retryRestore: () => void;
}

export const AdminContext = createContext<AdminContextValue | null>(null);

export function useAdmin(): AdminContextValue {
  const value = useContext(AdminContext);
  if (!value) throw new Error('fe-admin hooks must be used inside the admin app (createAdminApp)');
  return value;
}

/** Session-bound HTTP access for pages. */
export function useAdminApi(): AdminApi {
  return useAdmin().session.api;
}

export function useAdminConfig(): ResolvedAdminConfig {
  return useAdmin().config;
}

export function useAdminUser(): AdminUser | null {
  const { session } = useAdmin();
  return session.store((state) => state.user);
}

/**
 * Permission check through `@zucker-framework/fe-permission` (`*`/`superadmin`, exact code, `resource:*`).
 * An array means any one of the codes; `undefined` means any signed-in user.
 */
export function usePermissionCheck(): (permission?: string | readonly string[]) => boolean {
  const { session } = useAdmin();
  const { hasPermission } = session.usePermission();
  return useCallback(
    (permission?: string | readonly string[]) => {
      if (permission === undefined) return true;
      const codes = typeof permission === 'string' ? [permission] : permission;
      return codes.length === 0 || codes.some((code) => hasPermission(code));
    },
    [hasPermission],
  );
}

/**
 * Restore the access token from the refresh cookie when a persisted session summary exists. The
 * status follows the store: once nothing needs restoring any more (signed out with "Login again",
 * in another tab, or signed in) it is `ready`, so a failed restore never traps the page.
 */
export function useSessionRestore(session: AdminSession): { status: SessionStatus; retry: () => void } {
  const [status, setStatus] = useState<SessionStatus>(() => (session.needsRestore() ? 'restoring' : 'ready'));
  const [attempt, setAttempt] = useState(0);
  useEffect(
    () =>
      session.store.subscribe(() => {
        if (!session.needsRestore()) setStatus('ready');
      }),
    [session],
  );
  useEffect(() => {
    if (!session.needsRestore()) {
      setStatus('ready');
      return;
    }
    let active = true;
    setStatus('restoring');
    void session.restore().then((result: RestoreResult) => {
      if (active) setStatus(result === 'failed' && session.needsRestore() ? 'failed' : 'ready');
    });
    return () => {
      active = false;
    };
  }, [session, attempt]);
  return { status, retry: () => setAttempt((value) => value + 1) };
}

export interface ResourceState<T> {
  data: T | undefined;
  loading: boolean;
  error: boolean;
  reload: () => void;
  setData: (data: T) => void;
}

/**
 * Load one resource with explicit loading/error state. Requests are aborted on unmount and when
 * dependencies change; a failure keeps the previous data instead of replacing it with an empty value.
 */
export function useResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  options: { enabled?: boolean } = {},
): ResourceState<T> {
  const enabled = options.enabled ?? true;
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    load(controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setData(result);
        setError(false);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted && !isAbortError(failure)) setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [enabled, version, ...deps]);
  return { data, loading, error, reload: () => setVersion((value) => value + 1), setData };
}

/** Title of a page definition in the active locale. */
export function usePageTitle(): (page: Pick<AdminPageDefinition, 'title' | 'titleKey'>) => string {
  const { t, locale } = useAdminI18n();
  return useMemo(() => (page) => pageTitle(page, locale, t), [t, locale]);
}
