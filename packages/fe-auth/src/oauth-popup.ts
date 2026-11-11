import { isSafeRelativeRedirect } from './redirect';

/**
 * Popup OAuth sign-in over a same-origin BroadcastChannel.
 *
 * Opener (`openOAuthPopup`) and popup (`claimOAuthPopup`, on the web OAuth callback page) meet on
 * `BroadcastChannel('zucker-oauth:' + state)`. Protocol:
 *   popup → `{ type: 'ready' }`, opener → `{ type: 'claim' }` (popup waits at most 3 s),
 *   popup completes the sign-in itself, then → `{ type: 'done', returnPath? }` or
 *   `{ type: 'failed', code }`, repeated until the opener answers `{ type: 'ack' }`. The opener
 *   acknowledges and closes the popup; the popup also closes itself on `ack` (or after a bounded wait).
 *
 * Why the acknowledgement: the popup must not close itself right after posting its result. The opener
 * treats a closed popup without a result as `closed` (the user dismissed it) after a short grace, and on
 * a loaded machine the result could arrive after that grace (or be dropped with the closing window), so
 * a finished sign-in was misreported as a dismissed one. With the ack, a popup only disappears once the
 * opener holds the result (or the opener is gone).
 *
 * Invariants:
 * - No token, ticket or code ever crosses the channel. The opener restores its session through
 *   the existing cookie refresh, and must trust a `completed` result only once that refresh
 *   returns a session.
 * - The channel name contains the unguessable OAuth `state`; BroadcastChannel is same-origin by
 *   construction; every message is validated by exact shape and anything else is ignored.
 * - `blocked` (popup refused or BroadcastChannel unavailable) means: fall back to the redirect flow.
 */

export const OAUTH_POPUP_CHANNEL_PREFIX = 'zucker-oauth:';
const POPUP_WINDOW_NAME = 'zucker-oauth';
const POPUP_FEATURES = 'popup=yes,width=520,height=680';
const DEFAULT_TIMEOUT_MS = 120_000;
// Generous: a loaded machine can take well over 500 ms to deliver the opener's claim (flaky in e2e).
const DEFAULT_CLAIM_TIMEOUT_MS = 3000;
const CLOSED_POLL_MS = 500;
/** A popup posts `done` and closes at once; give that message time to arrive before reporting `closed`. */
const CLOSED_GRACE_MS = 300;
/** Popup side: re-post the result this often until the opener acknowledges it… */
const RESULT_RESEND_MS = 250;
/** …and close anyway after this long (the opener is gone or already settled). */
const RESULT_ACK_TIMEOUT_MS = 5000;
const STATE_PATTERN = /^[A-Za-z0-9._~-]{16,512}$/;
const FAILURE_CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const GENERIC_FAILURE_CODE = 'OAUTH_FAILED';

/** Minimal BroadcastChannel surface (injectable for tests). */
export interface OAuthPopupChannel {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type OAuthPopupChannelFactory = (name: string) => OAuthPopupChannel;

/** Minimal opened-window surface. */
export interface OAuthPopupHandle {
  readonly closed: boolean;
  close(): void;
}

/** Minimal opener-window surface (`window` by default). */
export interface OAuthPopupWindow {
  open(url: string, target: string, features: string): OAuthPopupHandle | null;
}

export interface OpenOAuthPopupOptions {
  /** Provider authorisation URL (or the app's start URL that redirects to it). */
  url: string;
  /** The OAuth `state` of this attempt (unguessable, 16–512 URL-safe characters). */
  state: string;
  /** Overall wait. Default 120 000 ms. */
  timeoutMs?: number;
  windowImpl?: OAuthPopupWindow;
  channelFactory?: OAuthPopupChannelFactory;
}

export type OAuthPopupResult =
  | { status: 'completed'; returnPath?: string }
  | { status: 'failed'; code: string }
  | { status: 'blocked' | 'closed' | 'timeout' };

type PopupMessage =
  | { type: 'ready' }
  | { type: 'claim' }
  | { type: 'ack' }
  | { type: 'done'; returnPath?: string }
  | { type: 'failed'; code: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Exact-shape validation; anything unexpected returns null and is ignored. */
export function parseOAuthPopupMessage(data: unknown): PopupMessage | null {
  if (!isPlainObject(data)) return null;
  const keys = Object.keys(data);
  switch (data.type) {
    case 'ready':
    case 'claim':
    case 'ack':
      return keys.length === 1 ? { type: data.type } : null;
    case 'done': {
      if (keys.some((key) => key !== 'type' && key !== 'returnPath')) return null;
      if (data.returnPath === undefined) return { type: 'done' };
      return typeof data.returnPath === 'string' ? { type: 'done', returnPath: data.returnPath } : null;
    }
    case 'failed':
      if (keys.length !== 2 || typeof data.code !== 'string') return null;
      return { type: 'failed', code: data.code };
    default:
      return null;
  }
}

function assertState(state: unknown): asserts state is string {
  if (typeof state !== 'string' || !STATE_PATTERN.test(state)) {
    throw new TypeError('OAuth popup state must be 16-512 URL-safe characters');
  }
}

function defaultChannelFactory(): OAuthPopupChannelFactory | undefined {
  const Ctor = (globalThis as { BroadcastChannel?: new (name: string) => OAuthPopupChannel }).BroadcastChannel;
  return Ctor ? (name) => new Ctor(name) : undefined;
}

function defaultWindow(): (OAuthPopupWindow & OAuthPopupHandle) | undefined {
  return (globalThis as { window?: OAuthPopupWindow & OAuthPopupHandle }).window;
}

/**
 * Open the provider sign-in in a popup and wait for the popup to report the outcome.
 * Call it synchronously from the click handler: the popup is opened before this returns,
 * so browsers treat it as user-initiated.
 */
export function openOAuthPopup(options: OpenOAuthPopupOptions): Promise<OAuthPopupResult> {
  assertState(options.state);
  if (typeof options.url !== 'string' || !options.url) throw new TypeError('OAuth popup url is required');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('OAuth popup timeoutMs must be positive');

  const factory = options.channelFactory ?? defaultChannelFactory();
  const windowImpl = options.windowImpl ?? defaultWindow();
  if (!factory || !windowImpl) return Promise.resolve({ status: 'blocked' });

  // Listen before opening so an early `ready` is not missed.
  let channel: OAuthPopupChannel;
  try {
    channel = factory(OAUTH_POPUP_CHANNEL_PREFIX + options.state);
  } catch {
    return Promise.resolve({ status: 'blocked' });
  }
  let popup: OAuthPopupHandle | null = null;
  try {
    popup = windowImpl.open(options.url, POPUP_WINDOW_NAME, POPUP_FEATURES);
  } catch {
    popup = null;
  }
  if (!popup) {
    channel.close();
    return Promise.resolve({ status: 'blocked' });
  }
  const opened = popup;

  return new Promise<OAuthPopupResult>((resolve) => {
    let settled = false;
    let closedTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: OAuthPopupResult, closePopup = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(poll);
      if (closedTimer !== undefined) clearTimeout(closedTimer);
      channel.onmessage = null;
      try {
        channel.close();
      } catch {
        // already closed
      }
      if (closePopup) {
        try {
          if (!opened.closed) opened.close();
        } catch {
          // cross-origin or already gone
        }
      }
      resolve(result);
    };

    // Tell the popup its result arrived (it stops re-posting and closes); we also close it ourselves.
    const acknowledge = () => {
      try {
        channel.postMessage({ type: 'ack' });
      } catch {
        // channel already gone; the popup closes itself after RESULT_ACK_TIMEOUT_MS
      }
    };
    channel.onmessage = (event) => {
      const message = parseOAuthPopupMessage(event?.data);
      if (!message || settled) return;
      if (message.type === 'ready') {
        channel.postMessage({ type: 'claim' });
      } else if (message.type === 'done') {
        const returnPath = message.returnPath !== undefined && isSafeRelativeRedirect(message.returnPath)
          ? message.returnPath
          : undefined;
        acknowledge();
        finish(returnPath === undefined ? { status: 'completed' } : { status: 'completed', returnPath }, true);
      } else if (message.type === 'failed') {
        acknowledge();
        finish({ status: 'failed', code: FAILURE_CODE_PATTERN.test(message.code) ? message.code : GENERIC_FAILURE_CODE }, true);
      }
    };

    const timeout = setTimeout(() => finish({ status: 'timeout' }, true), timeoutMs);
    const poll = setInterval(() => {
      let isClosed = false;
      try {
        isClosed = opened.closed;
      } catch {
        isClosed = false;
      }
      if (isClosed && closedTimer === undefined) {
        closedTimer = setTimeout(() => finish({ status: 'closed' }), CLOSED_GRACE_MS);
      }
    }, CLOSED_POLL_MS);
  });
}

export interface ClaimOAuthPopupOptions {
  /** How long the popup waits for the opener's `claim`. Default 3000 ms. */
  claimTimeoutMs?: number;
  channelFactory?: OAuthPopupChannelFactory;
  /** The popup's own window (closed after `complete`/`fail`). Default `window`. */
  windowImpl?: { close(): void };
}

/** Popup-side handle returned when an opener claimed this sign-in. */
export interface OAuthPopupClaim {
  /** Report success (after the sign-in completed in this popup); the popup closes once the opener acknowledges. */
  complete(returnPath?: string): void;
  /** Report failure with a short error code (never a secret); the popup closes once the opener acknowledges. */
  fail(code: string): void;
  /** Release the channel without reporting (the opener will see `closed` or `timeout`). */
  release(): void;
}

/**
 * Popup half: announce readiness on the state's channel and wait briefly for the opener.
 * Resolves `null` when no opener claims the attempt (normal redirect flow: complete in this tab),
 * when BroadcastChannel is unavailable, or for a malformed state.
 */
export function claimOAuthPopup(state: string, options: ClaimOAuthPopupOptions = {}): Promise<OAuthPopupClaim | null> {
  if (typeof state !== 'string' || !STATE_PATTERN.test(state)) return Promise.resolve(null);
  const factory = options.channelFactory ?? defaultChannelFactory();
  if (!factory) return Promise.resolve(null);
  const claimTimeoutMs = options.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS;
  let channel: OAuthPopupChannel;
  try {
    channel = factory(OAUTH_POPUP_CHANNEL_PREFIX + state);
  } catch {
    return Promise.resolve(null);
  }

  return new Promise<OAuthPopupClaim | null>((resolve) => {
    let settled = false;
    let released = false;
    let reporting = false;
    let resend: ReturnType<typeof setInterval> | undefined;
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const release = () => {
      if (released) return;
      released = true;
      clearInterval(resend);
      clearTimeout(giveUp);
      channel.onmessage = null;
      try {
        channel.close();
      } catch {
        // already closed
      }
    };
    const closeWindow = () => {
      try {
        (options.windowImpl ?? defaultWindow())?.close();
      } catch {
        // nothing to close
      }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      release();
      resolve(null);
    }, claimTimeoutMs);

    const finishAndClose = () => {
      release();
      closeWindow();
    };
    /** Post the (secret-free) result until the opener acknowledges it, then close this window. */
    const report = (message: PopupMessage) => {
      if (released || reporting) return;
      reporting = true;
      channel.onmessage = (event) => {
        if (parseOAuthPopupMessage(event?.data)?.type === 'ack') finishAndClose();
      };
      const post = () => {
        try {
          channel.postMessage(message);
        } catch {
          finishAndClose();
        }
      };
      post();
      if (released) return;
      resend = setInterval(post, RESULT_RESEND_MS);
      giveUp = setTimeout(finishAndClose, RESULT_ACK_TIMEOUT_MS);
    };

    channel.onmessage = (event) => {
      const message = parseOAuthPopupMessage(event?.data);
      if (settled || message?.type !== 'claim') return;
      settled = true;
      clearTimeout(timer);
      channel.onmessage = null;
      resolve({
        complete(returnPath?: string) {
          const safe = typeof returnPath === 'string' && isSafeRelativeRedirect(returnPath) ? returnPath : undefined;
          report(safe === undefined ? { type: 'done' } : { type: 'done', returnPath: safe });
        },
        fail(code: string) {
          const safe = typeof code === 'string' && FAILURE_CODE_PATTERN.test(code) ? code : GENERIC_FAILURE_CODE;
          report({ type: 'failed', code: safe });
        },
        release,
      });
    };
    channel.postMessage({ type: 'ready' });
  });
}
