/**
 * Cookie-refresh browser sessions: the access token lives in memory only, the refresh token is an
 * HttpOnly cookie, and a token-free summary (user + permissions) is persisted so a reload can
 * restore the session through one cookie exchange.
 *
 * Product-neutral mechanics; the application supplies the store, the refresh exchange, how to read
 * the signed-in account and how to turn it into store state:
 * - `restore()` runs at most once at a time per page, under a cross-tab lock, and never moves the
 *   page into a different account than its persisted summary names (`identity-changed`);
 * - `guardedRefresh()` is the refresh to give the HTTP client: it rejects with status 401 while
 *   signed out and for tokens of another session or account;
 * - `createSessionSummaryStorage()` keeps tabs consistent: a summary written by another tab for a
 *   different identity is never overwritten by this tab's stale state, and the `storage` event
 *   makes this tab drop its in-memory session when another tab signs out or switches account.
 */
import { createJSONStorage, type PersistStorage } from 'zustand/middleware';
import type { StoreApi, UseBoundStore } from 'zustand';
import { acceptsSessionToken, jwtSessionKey, type SessionKey } from './session';
import type { AuthState, AuthStore } from './store';

type SummaryState = Partial<Pick<AuthState<{ id: string }>, 'isAuthenticated' | 'user'>>;
type RawStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Identity named by a persisted summary: the user id, or null when signed out/unreadable. */
function summaryIdentity(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { state?: SummaryState } | null;
    const state = value?.state;
    return state?.isAuthenticated && typeof state.user?.id === 'string' ? state.user.id : null;
  } catch {
    return null;
  }
}

export interface SessionSummaryStorageOptions {
  /** Persist key (the same value passed to `createAuthStore({ persistKey })`). */
  key: string;
  /** Default `localStorage` when available. */
  storage?: RawStorage | null;
}

export interface SessionSummaryStorage<S> {
  /** Pass as `createAuthStore({ persistOptions: { storage } })`. */
  storage: PersistStorage<S>;
  /** Allow the next write to name a different identity (an explicit sign-in in this tab). */
  allowIdentityChange(): void;
  /** Identity currently persisted (possibly by another tab). */
  persistedIdentity(): string | null;
}

function defaultRawStorage(): RawStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Persist storage that refuses to overwrite another tab's summary: when the stored summary changed
 * since this tab last wrote it and names a different identity than the write, the write is skipped
 * unless this tab just signed in (`allowIdentityChange`). Same-identity writes always go through.
 */
export function createSessionSummaryStorage<S>(options: SessionSummaryStorageOptions): SessionSummaryStorage<S> {
  const raw = options.storage === undefined ? defaultRawStorage() : options.storage;
  const read = (): string | null => {
    try {
      return raw?.getItem(options.key) ?? null;
    } catch {
      return null;
    }
  };
  let lastWritten = read();
  let allowNext = false;
  const guarded: RawStorage = {
    getItem: (name) => {
      const value = raw?.getItem(name) ?? null;
      if (name === options.key) lastWritten = value;
      return value;
    },
    setItem: (name, value) => {
      if (!raw) return;
      if (name === options.key) {
        const current = read();
        const foreign = current !== lastWritten && summaryIdentity(current) !== summaryIdentity(value);
        if (foreign && !allowNext) return;
        allowNext = false;
        lastWritten = value;
      }
      raw.setItem(name, value);
    },
    removeItem: (name) => {
      if (name === options.key) lastWritten = null;
      raw?.removeItem(name);
    },
  };
  return {
    storage: createJSONStorage<S>(() => guarded) as PersistStorage<S>,
    allowIdentityChange: () => {
      allowNext = true;
    },
    persistedIdentity: () => summaryIdentity(read()),
  };
}

export type CookieSessionRestoreResult = 'authenticated' | 'anonymous' | 'failed';

export interface CookieSessionOptions<TUser extends { id: string }, TAccount> {
  store: UseBoundStore<StoreApi<AuthStore<TUser>>>;
  /** Cookie refresh exchange (for example `createRefreshExchange` from fe-http-client). */
  refresh: () => Promise<{ access_token: string }>;
  /** Read the account a freshly issued access token belongs to. */
  fetchAccount: (token: string) => Promise<TAccount>;
  /** Store state for an adopted account. */
  toState: (account: TAccount) => { user: TUser; permissions: string[] };
  sessionKey: SessionKey;
  /** Cross-tab lock shared with the HTTP client's refresh (`navigator.locks`); null disables it. */
  lockName?: string | null;
  locks?: Pick<LockManager, 'request'> | null;
  /** Summary storage guard created for the same store (enables cross-tab identity protection). */
  summary?: SessionSummaryStorage<unknown>;
  /** Persist key observed through `storage` events (default: none, no cross-tab listener). */
  persistKey?: string;
  /** Event source for `storage` events (default `window` when available). */
  events?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null;
  /** HTTP status of an error (default: `status` or `response.status`). */
  statusOf?: (error: unknown) => number | undefined;
  /**
   * Account id a token belongs to, compared with the summary's user while no access token is held
   * (default: the JWT `sub` claim). Null means unidentifiable, and such a token is rejected.
   */
  subjectOf?: (token: string) => string | null;
}

export interface CookieSession<TAccount> {
  /** Whether a persisted summary exists whose access token must be restored by cookie refresh. */
  needsRestore(): boolean;
  /** One restore at a time per page; concurrent callers share it. */
  restore(): Promise<CookieSessionRestoreResult>;
  /** Wait for a pending restore (for example before a sign-in) without failing. */
  settled(): Promise<void>;
  /** Refresh for the HTTP client: rejects (status 401) while signed out and a token of another session/account. */
  guardedRefresh(): Promise<{ access_token: string }>;
  /** Sign in with an access token obtained by this tab (login): reads the account and adopts it. */
  adoptToken(token: string): Promise<TAccount>;
  /** Run a task under the cross-tab refresh lock. */
  withLock<T>(task: () => Promise<T>): Promise<T>;
  /** Remove the cross-tab listener. */
  dispose(): void;
}

const subjectKey = jwtSessionKey(['sub']);
function jwtSubject(token: string): string | null {
  const key = subjectKey(token);
  if (!key) return null;
  const [subject] = JSON.parse(key) as [string | number];
  return String(subject);
}

function defaultStatus(error: unknown): number | undefined {
  const value = error as { status?: unknown; response?: { status?: unknown } } | null;
  const status = value?.status ?? value?.response?.status;
  return typeof status === 'number' ? status : undefined;
}

export function createCookieSession<TUser extends { id: string }, TAccount extends { id: string }>(
  options: CookieSessionOptions<TUser, TAccount>,
): CookieSession<TAccount> {
  const { store, sessionKey } = options;
  const statusOf = options.statusOf ?? defaultStatus;
  const lockName = options.lockName === undefined ? 'zucker-account-refresh' : options.lockName;
  const locks =
    options.locks === undefined ? (typeof navigator !== 'undefined' ? navigator.locks ?? null : null) : options.locks;

  function adopt(token: string, account: TAccount) {
    options.summary?.allowIdentityChange();
    const next = options.toState(account);
    store.getState().setAuthState({ token, user: next.user, permissions: next.permissions });
  }
  async function withLock<T>(task: () => Promise<T>): Promise<T> {
    // The lock is released when the task settles; the refresh exchange carries its own timeout.
    return locks && lockName ? (locks.request(lockName, task) as Promise<T>) : task();
  }
  const subjectOf = options.subjectOf ?? jwtSubject;
  const rejected = (message: string) => Object.assign(new Error(message), { status: 401 });
  async function guardedRefresh() {
    // Signed out in this tab: never exchange the shared cookie (it may belong to another tab's sign-in).
    const initial = store.getState();
    if (!initial.isAuthenticated || !initial.user) throw rejected('Not signed in');
    const result = await options.refresh();
    const state = store.getState();
    if (!state.isAuthenticated || !state.user) throw rejected('Not signed in');
    // Another tab may have signed in as someone else; never move this tab to that session.
    if (state.token) {
      if (!acceptsSessionToken(state, result.access_token, sessionKey)) throw rejected('Session changed');
    } else if (typeof result.access_token !== 'string' || subjectOf(result.access_token) !== state.user.id) {
      // A summary without an access token (restore pending): the token must name the same account.
      throw rejected('Session changed');
    }
    return result;
  }

  async function restoreOnce(): Promise<CookieSessionRestoreResult> {
    // The persisted summary names the session this page expects to continue.
    const expectedUser = store.getState().user?.id;
    try {
      const outcome = await withLock(async () => {
        const { access_token } = await options.refresh();
        if (typeof access_token !== 'string' || !access_token) throw Object.assign(new Error('No session'), { status: 401 });
        const account = await options.fetchAccount(access_token);
        const state = store.getState();
        // Signed in (or out) in this page while the exchange ran: keep that state. The rotated
        // cookie has been stored either way, so nothing is lost by discarding this result.
        if (state.token || !state.isAuthenticated) return 'superseded' as const;
        // The shared cookie now belongs to another account (another tab signed in).
        if (expectedUser && account.id !== expectedUser) return 'identity-changed' as const;
        adopt(access_token, account);
        return 'adopted' as const;
      });
      if (outcome === 'identity-changed') {
        store.getState().logout();
        return 'anonymous';
      }
      return outcome === 'adopted' || store.getState().token ? 'authenticated' : 'anonymous';
    } catch (error) {
      const status = statusOf(error);
      if (status === 401 || status === 403) {
        store.getState().logout();
        return 'anonymous';
      }
      // Network failure, timeout or unload: unknown outcome, the summary is kept for a retry.
      return 'failed';
    }
  }
  let restoring: Promise<CookieSessionRestoreResult> | null = null;

  // Cross-tab: another tab signed out or switched account → this tab drops its in-memory session.
  const events = options.events === undefined ? (typeof window === 'undefined' ? null : window) : options.events;
  const onStorage = (event: Event) => {
    const { key, newValue } = event as StorageEvent;
    if (!options.persistKey || key !== options.persistKey) return;
    const state = store.getState();
    const current = state.isAuthenticated ? state.user?.id ?? null : null;
    if (current === null || summaryIdentity(newValue) === current) return;
    // The summary guard keeps this logout from overwriting the other tab's summary.
    state.logout();
  };
  if (options.persistKey) events?.addEventListener('storage', onStorage);

  return {
    needsRestore: () => {
      const state = store.getState();
      return state.isAuthenticated && !state.token;
    },
    restore() {
      restoring ??= restoreOnce().finally(() => {
        restoring = null;
      });
      return restoring;
    },
    async settled() {
      await restoring?.catch(() => undefined);
    },
    guardedRefresh,
    async adoptToken(token) {
      const account = await options.fetchAccount(token);
      adopt(token, account);
      return account;
    },
    withLock,
    dispose: () => events?.removeEventListener('storage', onStorage),
  };
}
