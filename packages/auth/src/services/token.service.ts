import { Injectable, Inject, Logger, Optional, type OnApplicationBootstrap } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'node:crypto';
import { BusinessException } from '@zucker-framework/core';
import { TokenState, AllopatricLoginMode, type TokenInfo } from '../interfaces';
import type { ICache } from '@zucker-framework/cache';
import {
  AUTH_EVENT_TOPICS,
  createTokenCreatedEvent,
  createTokenChangedEvent,
  createTokenRemovedEvent,
} from '../events';

/** Minimal TopicEventBus interface to avoid hard dependency on @zucker-framework/event */
interface TopicEventBusLike {
  publish(topic: string, payload: unknown): Promise<void>;
}

export const TOKEN_CACHE = Symbol('TOKEN_CACHE');

/**
 * Token 黑名单缓存 key 前缀. Keys are `token:blacklist:<sha256 hex of the token>` so raw bearer
 * tokens never become cache key names. The legacy `token:blacklist:<raw token>` form written by
 * 1.0.19 builds is still read (one release of compatibility), never written.
 */
const BLACKLIST_PREFIX = 'token:blacklist:';
/**
 * Per-user revocation watermark key prefix. Value: epoch milliseconds. Any access token for
 * that user whose `iat` (seconds) falls in or before that second is rejected, unless it carries
 * an `rva` claim equal to the watermark (issued after the revocation, see
 * {@link TokenService.issueClaims}). Stored in the shared cache when one is configured, so
 * revocation works across processes and restarts.
 */
const REVOKED_AFTER_PREFIX = 'token:revoked-after:';
/**
 * Shared session-activity record: `token:active:<sha256 hex>` → {@link SharedSessionRecord}.
 * Written only when a cache is configured. It is the authority for inactivity expiry across
 * instances; the process-local `lastRequestTime` is never used alone to blacklist a token
 * when a cache is configured.
 */
const SESSION_PREFIX = 'token:active:';
/** Best-effort per-user index of shared sessions (`maxActiveSessions` / `OFFLINE_OTHER`). */
const USER_SESSIONS_PREFIX = 'token:user-sessions:';
/** Upper bound for how often `touch()` writes the shared record for one token. */
const MAX_TOUCH_THROTTLE_MS = 30_000;
/** Bound for the per-process touch throttle map. */
const MAX_TOUCH_ENTRIES = 50_000;
/** Bound for the per-user shared session index. */
const MAX_INDEXED_SESSIONS = 100;

/**
 * Claim that marks an access token as tracked by {@link TokenService} sessions. Tokens carrying
 * it are rejected as `inactive` when a cache is configured and their shared session record is
 * missing or idle (unless `enforceSessionInactivity` is false). Framework login adds it; product
 * code that calls `signIn` for its own tokens can add it with {@link TokenService.issueClaims}.
 */
export const SESSION_TRACKED_CLAIM = 'zsess';
/** Claim carrying the user revocation watermark (ms) that was current when the token was issued. */
export const REVOCATION_WATERMARK_CLAIM = 'rva';

/** States after which a token must never authenticate again (also written to the blacklist). */
const TERMINAL_STATES: ReadonlySet<TokenState> = new Set([
  TokenState.EXPIRED,
  TokenState.DENY,
  TokenState.REVOKED,
  TokenState.OFFLINE,
]);

/** Claims the guard extracts from an already signature-verified access token. */
export interface AccessTokenClaims {
  /** Subject / user id. */
  sub?: string;
  /** Issued-at, seconds since epoch. */
  iat?: number;
  /** Revocation watermark (ms) embedded at issue time ({@link REVOCATION_WATERMARK_CLAIM}). */
  rva?: number;
  /** True when the token carries {@link SESSION_TRACKED_CLAIM}. */
  sessionTracked?: boolean;
}

/** Why an access token was rejected by {@link TokenService.checkAccessToken}. */
export type AccessTokenRejection = 'revoked' | 'inactive' | 'user_revoked';

export interface TokenServiceOptions {
  /** 最大并发会话数，0 表示不限制 */
  maxActiveSessions?: number;
  /**
   * Token 黑名单 / 用户撤销水位 TTL（毫秒），默认 7 天。
   * Must be at least the access-token lifetime, otherwise a revoked token becomes valid again.
   */
  blacklistTtlMs?: number;
  /** 异地登录模式  */
  allopatricLoginMode?: AllopatricLoginMode;
  /**
   * With a cache configured: reject a token that carries {@link SESSION_TRACKED_CLAIM} when its
   * shared session record is missing (expired by inactivity, never signed in, or lost).
   * Default true. Set false to allow such tokens until JWT expiry.
   */
  enforceSessionInactivity?: boolean;
}

/** Shared (cache) view of one session, keyed by the token digest. */
interface SharedSessionRecord {
  userId: string;
  type: string;
  maxInactiveInterval?: number;
  /** epoch ms */
  signInTime: number;
  /** epoch ms; refreshed by `touch()` at most once per throttle window */
  lastRequestTime: number;
}

/** Entry of the per-user shared session index. */
interface SharedSessionRef {
  /** token digest */
  d: string;
  type: string;
  /** epoch ms */
  signInTime: number;
}

/** sha256 hex digest of a token, used for every cache key derived from a token. */
export function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function touchThrottle(maxInactiveInterval?: number): number {
  if (!maxInactiveInterval || maxInactiveInterval <= 0) return MAX_TOUCH_THROTTLE_MS;
  return Math.max(1, Math.min(MAX_TOUCH_THROTTLE_MS, Math.floor(maxInactiveInterval / 4)));
}

@Injectable()
export class TokenService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TokenService.name);

  /** 内存中的 token 会话映射（兜底存储） */
  private readonly tokens = new Map<string, TokenInfo>();
  private readonly userTokens = new Map<string, Set<string>>();
  // Independent from sessions: signOut removes sessions, not revocation evidence.
  // Keyed by token digest.
  private readonly revokedTokens = new Map<string, number>();
  /** Process-local user revocation watermarks (used only when no shared cache is configured). */
  private readonly revokedAfter = new Map<string, { at: number; expiresAt: number }>();
  /** digest → last time this process wrote the shared session record. */
  private readonly sharedTouchAt = new Map<string, number>();
  private lastSweep = Date.now();

  private maxActiveSessions = 0;
  private blacklistTtlMs = 7 * 24 * 60 * 60 * 1000; // 7 天
  private allopatricLoginMode = AllopatricLoginMode.ALLOW;
  private enforceSessionInactivity = true;

  private cache?: ICache;
  private cacheResolver?: () => ICache | null | undefined;

  constructor(
    @Optional() @Inject(TOKEN_CACHE) cache?: ICache,
    @Optional() private readonly jwtService?: JwtService,
    @Optional() @Inject('TOPIC_EVENT_BUS') private readonly topicEventBus?: TopicEventBusLike,
  ) {
    this.cache = cache ?? undefined;
  }

  /** 配置选项（在模块初始化时调用） */
  configure(options: TokenServiceOptions): void {
    if (options.maxActiveSessions !== undefined) {
      this.maxActiveSessions = options.maxActiveSessions;
    }
    if (options.blacklistTtlMs !== undefined) {
      this.blacklistTtlMs = options.blacklistTtlMs;
    }
    if (options.allopatricLoginMode !== undefined) {
      this.allopatricLoginMode = options.allopatricLoginMode;
    }
    if (options.enforceSessionInactivity !== undefined) {
      this.enforceSessionInactivity = options.enforceSessionInactivity;
    }
  }

  /**
   * Resolve the shared cache lazily (used by `forRootAsync` with an options-level
   * `cacheProvider`, which cannot be injected before the options are known). The resolver is
   * called at application bootstrap, when every singleton exists, and must return the cache.
   */
  setCacheResolver(resolver: () => ICache | null | undefined): void {
    this.cacheResolver = resolver;
  }

  onApplicationBootstrap(): void {
    if (!this.cacheResolver || this.cache) return;
    const resolved = this.cacheResolver();
    if (!resolved) {
      throw new Error('[TokenService] cacheProvider is configured but did not resolve to a cache instance');
    }
    this.cache = resolved;
  }

  /**
   * The shared cache, or undefined for process-local mode. With a cache resolver the cache is
   * only available after `onApplicationBootstrap`: resolving earlier could capture a provider
   * Nest has not constructed yet, so calls made before bootstrap use process memory.
   */
  private getCache(): ICache | undefined {
    return this.cache;
  }

  /**
   * Claims to embed in a newly issued access token for `userId`:
   * - {@link SESSION_TRACKED_CLAIM}, so the shared session record governs inactivity;
   * - {@link REVOCATION_WATERMARK_CLAIM} when the user has a revocation watermark, so a token
   *   issued in the same second as `revokeUserTokens` (password change + re-login) is accepted.
   *
   * Call it right before signing, and register the signed token with {@link signIn}.
   */
  async issueClaims(userId: string): Promise<Record<string, unknown>> {
    const claims: Record<string, unknown> = { [SESSION_TRACKED_CLAIM]: 1 };
    const watermark = await this.getUserRevokedAt(userId);
    if (watermark !== undefined) claims[REVOCATION_WATERMARK_CLAIM] = watermark;
    return claims;
  }

  async signIn(userId: string, token: string, type = 'default', maxInactiveInterval?: number): Promise<TokenInfo> {
    await this.sweepIfDue();
    const cache = this.getCache();
    if (cache) {
      await this.applySharedLoginPolicy(cache, userId, type);
    } else {
      await this.applyLocalLoginPolicy(userId, type);
    }

    const now = new Date();
    const tokenInfo: TokenInfo = {
      token,
      userId,
      type,
      state: TokenState.NORMAL,
      signInTime: now,
      lastRequestTime: now,
      requestTimes: 0,
      maxInactiveInterval,
    };

    this.tokens.set(token, tokenInfo);

    const userSet = this.userTokens.get(userId) || new Set();
    userSet.add(token);
    this.userTokens.set(userId, userSet);

    if (cache) {
      const digest = tokenDigest(token);
      await this.writeSession(cache, digest, {
        userId,
        type,
        ...(maxInactiveInterval ? { maxInactiveInterval } : {}),
        signInTime: now.getTime(),
        lastRequestTime: now.getTime(),
      });
      this.sharedTouchAt.set(digest, now.getTime());
      await this.addToUserIndex(cache, userId, { d: digest, type, signInTime: now.getTime() });
    }

    // Publish token created event
    await this.publishEvent(
      AUTH_EVENT_TOPICS.TOKEN_CREATED,
      createTokenCreatedEvent(token, userId, type),
    );

    return tokenInfo;
  }

  /** Allopatric / max-session policy from this process's sessions (no cache configured). */
  private async applyLocalLoginPolicy(userId: string, type: string): Promise<void> {
    const existing = await this.getByUserId(userId);
    const activeSessions = existing.filter(
      (t) => t.state === TokenState.NORMAL && t.type === type,
    );

    if (this.allopatricLoginMode === AllopatricLoginMode.DENY && activeSessions.length > 0) {
      throw new BusinessException('用户已在其他地方登录，拒绝登录', 'ALLOPATRIC_LOGIN_DENIED', 409);
    }

    if (this.allopatricLoginMode === AllopatricLoginMode.OFFLINE_OTHER) {
      for (const session of activeSessions) {
        await this.changeState(session.token, TokenState.OFFLINE);
        this.logger.log(`异地登录控制：用户 ${userId} 的旧会话已被踢下线`);
      }
    }

    // 并发登录控制：如果超过最大会话数，撤销最早的 token
    if (this.maxActiveSessions > 0) {
      const currentActive = (await this.getByUserId(userId)).filter(
        (t) => t.state === TokenState.NORMAL,
      );
      if (currentActive.length >= this.maxActiveSessions) {
        currentActive.sort((a, b) => a.signInTime.getTime() - b.signInTime.getTime());
        const toRevoke = currentActive.slice(0, currentActive.length - this.maxActiveSessions + 1);
        for (const old of toRevoke) {
          await this.revokeToken(old.token);
          this.logger.log(
            `并发登录控制：用户 ${userId} 超过最大会话数 ${this.maxActiveSessions}，已撤销旧 token`,
          );
        }
      }
    }
  }

  /**
   * Allopatric / max-session policy from the shared per-user index, so sessions created on
   * other instances count too. The index is read-modify-write without a lock: two concurrent
   * logins of the same user on different instances may both pass the limit (best effort).
   */
  private async applySharedLoginPolicy(cache: ICache, userId: string, type: string): Promise<void> {
    if (this.allopatricLoginMode === AllopatricLoginMode.ALLOW && this.maxActiveSessions <= 0) return;
    const active = await this.liveSharedSessions(cache, userId);
    const sameType = active.filter((s) => s.type === type);

    if (this.allopatricLoginMode === AllopatricLoginMode.DENY && sameType.length > 0) {
      throw new BusinessException('用户已在其他地方登录，拒绝登录', 'ALLOPATRIC_LOGIN_DENIED', 409);
    }

    let remaining = active;
    if (this.allopatricLoginMode === AllopatricLoginMode.OFFLINE_OTHER) {
      for (const session of sameType) {
        await this.revokeByDigest(cache, session.d, TokenState.OFFLINE);
        this.logger.log(`异地登录控制：用户 ${userId} 的旧会话已被踢下线`);
      }
      remaining = active.filter((s) => s.type !== type);
    }

    if (this.maxActiveSessions > 0 && remaining.length >= this.maxActiveSessions) {
      const sorted = [...remaining].sort((a, b) => a.signInTime - b.signInTime);
      for (const old of sorted.slice(0, sorted.length - this.maxActiveSessions + 1)) {
        await this.revokeByDigest(cache, old.d, TokenState.DENY);
        this.logger.log(
          `并发登录控制：用户 ${userId} 超过最大会话数 ${this.maxActiveSessions}，已撤销旧 token`,
        );
      }
    }
  }

  /**
   * Sign a token out. The token is also blacklisted so that a signed-out (or kicked) JWT
   * cannot keep authenticating until its natural expiry.
   */
  async signOut(token: string): Promise<void> {
    await this.blacklist(token);
    const cache = this.getCache();
    if (cache) {
      const digest = tokenDigest(token);
      await cache.del(`${SESSION_PREFIX}${digest}`);
      this.sharedTouchAt.delete(digest);
    }
    const info = this.tokens.get(token);
    if (info) {
      const userSet = this.userTokens.get(info.userId);
      userSet?.delete(token);
      if (userSet?.size === 0) {
        this.userTokens.delete(info.userId);
      }
      // Publish token removed event
      await this.publishEvent(
        AUTH_EVENT_TOPICS.TOKEN_REMOVED,
        createTokenRemovedEvent(token, info.userId),
      );
    }
    this.tokens.delete(token);
  }

  /** 撤销单个 token，加入黑名单 */
  async revokeToken(token: string): Promise<void> {
    const info = this.tokens.get(token);
    if (info) {
      info.state = TokenState.DENY;
    }
    await this.signOut(token);
  }

  /**
   * 撤销用户所有 token（强制登出）.
   *
   * Besides blacklisting the sessions this process knows about, a per-user watermark is
   * recorded so that tokens issued by other instances, or before a restart, are rejected by
   * {@link checkAccessToken}. With a shared cache (`cacheProvider`) this is cross-process.
   * Tokens whose `iat` falls in the same second as the revocation are also rejected unless
   * they carry the new watermark in their `rva` claim ({@link issueClaims}).
   *
   * @returns the new watermark (epoch ms)
   */
  async revokeUserTokens(userId: string): Promise<number> {
    const watermark = await this.markUserRevoked(userId);
    const tokens = await this.getByUserId(userId);
    for (const tokenInfo of tokens) {
      await this.revokeToken(tokenInfo.token);
    }
    const cache = this.getCache();
    if (cache) await cache.del(`${USER_SESSIONS_PREFIX}${userId}`);
    this.logger.log(`用户 ${userId} 的所有 token 已撤销`);
    return watermark;
  }

  /**
   * Request-time check used by JwtAuthGuard after the signature has been verified.
   * Returns the rejection reason, or null when the token may be used.
   */
  async checkAccessToken(token: string, claims: AccessTokenClaims = {}): Promise<AccessTokenRejection | null> {
    if (await this.isBlacklisted(token)) return 'revoked';

    const cache = this.getCache();
    let shared: SharedSessionRecord | undefined;
    if (cache) {
      shared = await this.readSession(cache, tokenDigest(token));
      if (shared) {
        if (this.isIdle(shared, Date.now())) return 'inactive';
      } else if (claims.sessionTracked && this.enforceSessionInactivity) {
        // Framework-tracked token without a live shared session: expired by inactivity on
        // another instance, signed in before the record existed, or the record was lost.
        return 'inactive';
      }
    }

    const info = await this.resolveLocalSession(token, shared);
    if (info && info.state !== TokenState.NORMAL) return 'inactive';
    const userId = claims.sub ?? info?.userId ?? shared?.userId;
    if (userId) {
      const revokedAt = await this.getUserRevokedAt(userId);
      if (revokedAt !== undefined) {
        // A token issued after the revocation carries the watermark it was issued under.
        if (claims.rva === revokedAt) return null;
        // iat has second precision, so a token issued in the revocation second is rejected
        // too. Tokens without iat cannot be ordered against the watermark; reject them.
        if (typeof claims.iat !== 'number' || claims.iat <= Math.floor(revokedAt / 1000)) {
          return 'user_revoked';
        }
      }
    }
    return null;
  }

  /** Token 轮换：旧 token 失效，签发新 token */
  async rotateToken(
    oldToken: string,
    payload: Record<string, unknown>,
  ): Promise<{ token: string; tokenInfo: TokenInfo } | null> {
    const oldInfo = this.tokens.get(oldToken);
    if (!oldInfo || oldInfo.state !== TokenState.NORMAL) {
      return null;
    }

    if (!this.jwtService) {
      this.logger.warn('Token 轮换需要 JwtService，但未注入');
      return null;
    }

    // 撤销旧 token
    await this.revokeToken(oldToken);

    // 签发新 token (keeping the session's type and inactivity policy)
    const newToken = this.jwtService.sign({ ...payload, ...(await this.issueClaims(oldInfo.userId)) });
    const tokenInfo = await this.signIn(oldInfo.userId, newToken, oldInfo.type, oldInfo.maxInactiveInterval);

    return { token: newToken, tokenInfo };
  }

  /** 检查 token 是否在黑名单中 */
  async isBlacklisted(token: string): Promise<boolean> {
    const digest = tokenDigest(token);
    const cache = this.getCache();
    if (cache) {
      if (await cache.has(`${BLACKLIST_PREFIX}${digest}`)) return true;
      // Legacy raw-token key written by 1.0.19 builds; remove after one release.
      return cache.has(`${BLACKLIST_PREFIX}${token}`);
    }
    this.pruneRevocations();
    return this.revokedTokens.has(digest) || this.tokens.get(token)?.state === TokenState.DENY;
  }

  /**
   * Get token info, checking for timeout expiration first.
   *
   * A normal token expires when its positive maxInactiveInterval is exceeded. With a cache
   * configured the shared session record decides: a token that is idle in this process but
   * active on another instance is kept (and its local `lastRequestTime` synchronised).
   * Missing tokens return null; other token states are preserved.
   */
  async getByToken(token: string): Promise<TokenInfo | null> {
    return this.resolveLocalSession(token);
  }

  private async resolveLocalSession(token: string, sharedHint?: SharedSessionRecord): Promise<TokenInfo | null> {
    const info = this.tokens.get(token) || null;
    if (!info) return null;
    if (this.isLocallyIdle(info, Date.now()) && (await this.confirmIdle(info, sharedHint))) {
      await this.changeState(info.token, TokenState.EXPIRED);
    }
    return info;
  }

  async getByUserId(userId: string): Promise<TokenInfo[]> {
    const tokenIds = this.userTokens.get(userId);
    if (!tokenIds) return [];
    return Array.from(tokenIds)
      .map((t) => this.tokens.get(t))
      .filter((t): t is TokenInfo => t !== undefined);
  }

  /**
   * Change a session's state. Terminal states (expired/deny/revoked/offline) also blacklist
   * the token so other processes reject it; LOCK is reversible and stays process-local.
   */
  async changeState(token: string, state: TokenState): Promise<void> {
    if (TERMINAL_STATES.has(state)) {
      await this.blacklist(token);
      const cache = this.getCache();
      if (cache) await cache.del(`${SESSION_PREFIX}${tokenDigest(token)}`);
    }
    const info = this.tokens.get(token);
    if (info) {
      const oldState = info.state;
      info.state = state;
      // Publish token changed event
      await this.publishEvent(
        AUTH_EVENT_TOPICS.TOKEN_CHANGED,
        createTokenChangedEvent(token, info.userId, oldState, state),
      );
    }
  }

  /**
   * Record activity. Updates the local session and, with a cache, refreshes the shared session
   * record (throttled to at most once per `min(30 s, maxInactiveInterval / 4)` per token and
   * process). Tokens without a shared record (not signed in through {@link signIn}) are ignored.
   */
  async touch(token: string): Promise<void> {
    const now = Date.now();
    const info = this.tokens.get(token);
    if (info) {
      info.lastRequestTime = new Date(now);
      info.requestTimes = (info.requestTimes || 0) + 1;
    }
    const cache = this.getCache();
    if (!cache) return;
    const digest = tokenDigest(token);
    const last = this.sharedTouchAt.get(digest);
    if (last !== undefined && now - last < touchThrottle(info?.maxInactiveInterval)) return;
    const record = await this.readSession(cache, digest);
    if (!record || this.isIdle(record, now)) return;
    if (last === undefined && now - record.lastRequestTime < touchThrottle(record.maxInactiveInterval)) {
      // First touch seen by this process and the record is fresh: no write needed.
      this.rememberTouch(digest, record.lastRequestTime);
      return;
    }
    record.lastRequestTime = now;
    await this.writeSession(cache, digest, record);
    this.rememberTouch(digest, now);
  }

  /** Check if a user has any active (normal) sessions. */
  async userIsLoggedIn(userId: string): Promise<boolean> {
    const tokens = await this.getByUserId(userId);
    return tokens.some((t) => t.state === TokenState.NORMAL);
  }

  /** Check if a specific token is logged in (normal state). */
  async tokenIsLoggedIn(token: string): Promise<boolean> {
    const info = await this.getByToken(token);
    return info?.state === TokenState.NORMAL;
  }

  /** Total number of unique logged-in users. */
  async totalUsers(): Promise<number> {
    return this.userTokens.size;
  }

  /** Get all active tokens. */
  async allLoggedTokens(): Promise<TokenInfo[]> {
    return Array.from(this.tokens.values());
  }

  /** Change state for all tokens of a user. Terminal states also revoke across processes. */
  async changeUserState(userId: string, state: TokenState): Promise<void> {
    if (TERMINAL_STATES.has(state)) {
      await this.markUserRevoked(userId);
    }
    const tokens = await this.getByUserId(userId);
    for (const tokenInfo of tokens) {
      await this.changeState(tokenInfo.token, state);
    }
  }

  /**
   * Check all tokens for expiration, expire timed-out ones and remove them.
   *
   * With a cache configured a session is expired only when the shared record agrees it is
   * idle (or the record is gone and `enforceSessionInactivity` is on); a token used on another
   * instance is never blacklisted because this process did not see its requests.
   */
  async checkExpired(): Promise<void> {
    const now = Date.now();
    // Snapshot keys to avoid mutation during iteration
    for (const [token, info] of Array.from(this.tokens.entries())) {
      if (info.state === TokenState.NORMAL && this.isLocallyIdle(info, now) && (await this.confirmIdle(info))) {
        await this.changeState(token, TokenState.EXPIRED);
      }
    }
    // Now remove all expired tokens
    for (const [token, info] of Array.from(this.tokens.entries())) {
      if (info.state === TokenState.EXPIRED) {
        await this.signOut(token);
      }
    }
  }

  /** Kick a user offline: every token of that user (on any instance sharing the cache) is revoked. */
  async signOutByUserId(userId: string): Promise<void> {
    await this.markUserRevoked(userId);
    const cache = this.getCache();
    if (cache) await cache.del(`${USER_SESSIONS_PREFIX}${userId}`);
    const tokenIds = this.userTokens.get(userId);
    if (!tokenIds) return;
    for (const token of Array.from(tokenIds)) {
      await this.blacklist(token);
      if (cache) await cache.del(`${SESSION_PREFIX}${tokenDigest(token)}`);
      // Publish token removed event for each token
      await this.publishEvent(
        AUTH_EVENT_TOPICS.TOKEN_REMOVED,
        createTokenRemovedEvent(token, userId),
      );
      this.tokens.delete(token);
    }
    this.userTokens.delete(userId);
  }

  async totalTokens(): Promise<number> {
    return this.tokens.size;
  }

  // ---------------------------------------------------------------------------
  // Inactivity
  // ---------------------------------------------------------------------------

  private isLocallyIdle(info: TokenInfo, now: number): boolean {
    return (
      !!info.maxInactiveInterval &&
      info.maxInactiveInterval > 0 &&
      info.state === TokenState.NORMAL &&
      now - info.lastRequestTime.getTime() > info.maxInactiveInterval
    );
  }

  /**
   * Shared record is idle. `touch()` writes at most once per throttle window, so the recorded
   * time may lag the real last request by up to that window; it is allowed as grace.
   */
  private isIdle(record: SharedSessionRecord, now: number): boolean {
    const interval = record.maxInactiveInterval;
    if (!interval || interval <= 0) return false;
    return now - record.lastRequestTime > interval + touchThrottle(interval);
  }

  /**
   * For a session that looks idle in this process: is it idle everywhere? Without a cache the
   * local view is authoritative. With a cache the shared record decides; when it shows recent
   * activity the local `lastRequestTime` is synchronised.
   */
  private async confirmIdle(info: TokenInfo, sharedHint?: SharedSessionRecord): Promise<boolean> {
    const cache = this.getCache();
    if (!cache) return true;
    const record = sharedHint ?? (await this.readSession(cache, tokenDigest(info.token)));
    if (!record) return this.enforceSessionInactivity;
    if (this.isIdle(record, Date.now())) return true;
    info.lastRequestTime = new Date(Math.max(info.lastRequestTime.getTime(), record.lastRequestTime));
    return false;
  }

  private rememberTouch(digest: string, at: number): void {
    if (this.sharedTouchAt.size >= MAX_TOUCH_ENTRIES) {
      const cutoff = Date.now() - MAX_TOUCH_THROTTLE_MS;
      for (const [key, value] of this.sharedTouchAt) {
        if (value < cutoff) this.sharedTouchAt.delete(key);
      }
      if (this.sharedTouchAt.size >= MAX_TOUCH_ENTRIES) this.sharedTouchAt.clear();
    }
    this.sharedTouchAt.set(digest, at);
  }

  // ---------------------------------------------------------------------------
  // Shared session records
  // ---------------------------------------------------------------------------

  private sessionTtl(record: SharedSessionRecord): number {
    const interval = record.maxInactiveInterval;
    if (interval && interval > 0) return interval + touchThrottle(interval);
    return Math.max(1, record.signInTime + this.blacklistTtlMs - Date.now());
  }

  private async writeSession(cache: ICache, digest: string, record: SharedSessionRecord): Promise<void> {
    await cache.set(`${SESSION_PREFIX}${digest}`, record, this.sessionTtl(record));
  }

  private async readSession(cache: ICache, digest: string): Promise<SharedSessionRecord | undefined> {
    const value = await cache.get(`${SESSION_PREFIX}${digest}`);
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Partial<SharedSessionRecord>;
    if (
      typeof record.userId !== 'string' ||
      typeof record.lastRequestTime !== 'number' ||
      typeof record.signInTime !== 'number'
    ) {
      return undefined;
    }
    return {
      userId: record.userId,
      type: typeof record.type === 'string' ? record.type : 'default',
      signInTime: record.signInTime,
      lastRequestTime: record.lastRequestTime,
      ...(typeof record.maxInactiveInterval === 'number' ? { maxInactiveInterval: record.maxInactiveInterval } : {}),
    };
  }

  private async readUserIndex(cache: ICache, userId: string): Promise<SharedSessionRef[]> {
    const value = await cache.get(`${USER_SESSIONS_PREFIX}${userId}`);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (entry): entry is SharedSessionRef =>
        !!entry && typeof entry === 'object' &&
        typeof (entry as SharedSessionRef).d === 'string' &&
        typeof (entry as SharedSessionRef).signInTime === 'number',
    );
  }

  /** Index entries whose session record still exists, is not idle and is not blacklisted. */
  private async liveSharedSessions(cache: ICache, userId: string): Promise<SharedSessionRef[]> {
    const now = Date.now();
    const live: SharedSessionRef[] = [];
    for (const ref of await this.readUserIndex(cache, userId)) {
      const record = await this.readSession(cache, ref.d);
      if (!record || this.isIdle(record, now)) continue;
      if (await cache.has(`${BLACKLIST_PREFIX}${ref.d}`)) continue;
      live.push({ d: ref.d, type: record.type, signInTime: record.signInTime });
    }
    return live;
  }

  private async addToUserIndex(cache: ICache, userId: string, ref: SharedSessionRef): Promise<void> {
    const live = (await this.liveSharedSessions(cache, userId)).filter((entry) => entry.d !== ref.d);
    const next = [...live, ref].slice(-MAX_INDEXED_SESSIONS);
    await cache.set(`${USER_SESSIONS_PREFIX}${userId}`, next, this.blacklistTtlMs);
  }

  /** Revoke a session known only by digest (possibly signed in on another instance). */
  private async revokeByDigest(cache: ICache, digest: string, state: TokenState): Promise<void> {
    await cache.set(`${BLACKLIST_PREFIX}${digest}`, true, this.blacklistTtlMs);
    await cache.del(`${SESSION_PREFIX}${digest}`);
    this.sharedTouchAt.delete(digest);
    for (const [token, info] of this.tokens) {
      if (tokenDigest(token) !== digest) continue;
      const oldState = info.state;
      info.state = state;
      await this.publishEvent(
        AUTH_EVENT_TOPICS.TOKEN_CHANGED,
        createTokenChangedEvent(token, info.userId, oldState, state),
      );
      break;
    }
  }

  // ---------------------------------------------------------------------------
  // Revocation evidence
  // ---------------------------------------------------------------------------

  private pruneRevocations(): void {
    const now = Date.now();
    for (const [digest, expiresAt] of this.revokedTokens) {
      if (expiresAt <= now) this.revokedTokens.delete(digest);
    }
    for (const [userId, entry] of this.revokedAfter) {
      if (entry.expiresAt <= now) this.revokedAfter.delete(userId);
    }
  }

  /**
   * Blacklist a token. With a cache the write is awaited and its failure propagates: a cache
   * provider used here must not swallow write errors, or a revocation could be silently lost.
   */
  private async blacklist(token: string): Promise<void> {
    const digest = tokenDigest(token);
    const cache = this.getCache();
    if (cache) {
      await cache.set(`${BLACKLIST_PREFIX}${digest}`, true, this.blacklistTtlMs);
    } else {
      this.pruneRevocations();
      this.revokedTokens.set(digest, Date.now() + this.blacklistTtlMs);
    }
  }

  private removeSession(token: string): void {
    const info = this.tokens.get(token);
    if (!info) return;
    const userSet = this.userTokens.get(info.userId);
    userSet?.delete(token);
    if (userSet?.size === 0) this.userTokens.delete(info.userId);
  }

  private async markUserRevoked(userId: string): Promise<number> {
    // Strictly increasing per user within a process, so an `rva` claim issued under an older
    // watermark can never equal a newer one written in the same millisecond.
    const previous = await this.getUserRevokedAt(userId);
    const now = Math.max(Date.now(), previous !== undefined ? previous + 1 : 0);
    const cache = this.getCache();
    if (cache) {
      await cache.set(`${REVOKED_AFTER_PREFIX}${userId}`, now, this.blacklistTtlMs);
    } else {
      this.pruneRevocations();
      this.revokedAfter.set(userId, { at: now, expiresAt: now + this.blacklistTtlMs });
    }
    return now;
  }

  private async getUserRevokedAt(userId: string): Promise<number | undefined> {
    const cache = this.getCache();
    if (cache) {
      const value = await cache.get(`${REVOKED_AFTER_PREFIX}${userId}`);
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    }
    const entry = this.revokedAfter.get(userId);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.revokedAfter.delete(userId);
      return undefined;
    }
    return entry.at;
  }

  /**
   * Bound in-memory growth without requiring consumers to schedule checkExpired():
   * at most once a minute, drop sessions older than the blacklist TTL (which must cover
   * the JWT lifetime) and expired inactivity sessions.
   */
  private async sweepIfDue(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    this.pruneRevocations();
    for (const [token, info] of Array.from(this.tokens.entries())) {
      if (now - info.signInTime.getTime() > this.blacklistTtlMs) {
        this.removeSession(token);
        this.tokens.delete(token);
      }
    }
    for (const [digest, at] of Array.from(this.sharedTouchAt.entries())) {
      if (now - at > MAX_TOUCH_THROTTLE_MS) this.sharedTouchAt.delete(digest);
    }
    await this.checkExpired();
  }

  private async publishEvent(topic: string, payload: unknown): Promise<void> {
    if (this.topicEventBus) {
      await this.topicEventBus.publish(topic, payload);
    }
  }
}
