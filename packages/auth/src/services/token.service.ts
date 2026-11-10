import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
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

/** Token 黑名单缓存 key 前缀 */
const BLACKLIST_PREFIX = 'token:blacklist:';
/**
 * Per-user revocation watermark key prefix. Value: epoch milliseconds. Any access token for
 * that user whose `iat` (seconds) falls in or before that second is rejected. Stored in the
 * shared cache when one is configured, so revocation works across processes and restarts.
 */
const REVOKED_AFTER_PREFIX = 'token:revoked-after:';

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
}

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  /** 内存中的 token 会话映射（兜底存储） */
  private readonly tokens = new Map<string, TokenInfo>();
  private readonly userTokens = new Map<string, Set<string>>();
  // Independent from sessions: signOut removes sessions, not revocation evidence.
  private readonly revokedTokens = new Map<string, number>();
  /** Process-local user revocation watermarks (used only when no shared cache is configured). */
  private readonly revokedAfter = new Map<string, { at: number; expiresAt: number }>();
  private lastSweep = Date.now();

  private maxActiveSessions = 0;
  private blacklistTtlMs = 7 * 24 * 60 * 60 * 1000; // 7 天
  private allopatricLoginMode = AllopatricLoginMode.ALLOW;

  constructor(
    @Optional() @Inject(TOKEN_CACHE) private readonly cache?: ICache,
    @Optional() private readonly jwtService?: JwtService,
    @Optional() @Inject('TOPIC_EVENT_BUS') private readonly topicEventBus?: TopicEventBusLike,
  ) {}

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
  }

  async signIn(userId: string, token: string, type = 'default', maxInactiveInterval?: number): Promise<TokenInfo> {
    await this.sweepIfDue();
    // Allopatric login mode handling
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
        // 按登录时间排序，撤销最早的
        currentActive.sort(
          (a, b) => a.signInTime.getTime() - b.signInTime.getTime(),
        );
        const toRevoke = currentActive.slice(
          0,
          currentActive.length - this.maxActiveSessions + 1,
        );
        for (const old of toRevoke) {
          await this.revokeToken(old.token);
          this.logger.log(
            `并发登录控制：用户 ${userId} 超过最大会话数 ${this.maxActiveSessions}，已撤销旧 token`,
          );
        }
      }
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

    // Publish token created event
    await this.publishEvent(
      AUTH_EVENT_TOPICS.TOKEN_CREATED,
      createTokenCreatedEvent(token, userId, type),
    );

    return tokenInfo;
  }

  /**
   * Sign a token out. The token is also blacklisted so that a signed-out (or kicked) JWT
   * cannot keep authenticating until its natural expiry.
   */
  async signOut(token: string): Promise<void> {
    await this.blacklist(token);
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
   * Tokens whose `iat` falls in the same second as the revocation are also rejected.
   */
  async revokeUserTokens(userId: string): Promise<void> {
    await this.markUserRevoked(userId);
    const tokens = await this.getByUserId(userId);
    for (const tokenInfo of tokens) {
      await this.revokeToken(tokenInfo.token);
    }
    this.logger.log(`用户 ${userId} 的所有 token 已撤销`);
  }

  /**
   * Request-time check used by JwtAuthGuard after the signature has been verified.
   * Returns the rejection reason, or null when the token may be used.
   */
  async checkAccessToken(token: string, claims: AccessTokenClaims = {}): Promise<AccessTokenRejection | null> {
    if (await this.isBlacklisted(token)) return 'revoked';
    const info = await this.getByToken(token);
    if (info && info.state !== TokenState.NORMAL) return 'inactive';
    const userId = claims.sub ?? info?.userId;
    if (userId) {
      const revokedAt = await this.getUserRevokedAt(userId);
      if (revokedAt !== undefined) {
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
    const newToken = this.jwtService.sign(payload);
    const tokenInfo = await this.signIn(oldInfo.userId, newToken, oldInfo.type, oldInfo.maxInactiveInterval);

    return { token: newToken, tokenInfo };
  }

  /** 检查 token 是否在黑名单中 */
  async isBlacklisted(token: string): Promise<boolean> {
    if (this.cache) {
      return this.cache.has(`${BLACKLIST_PREFIX}${token}`);
    }
    this.pruneRevocations();
    return this.revokedTokens.has(token) || this.tokens.get(token)?.state === TokenState.DENY;
  }

  /**
   * Get token info, checking for timeout expiration first.
   *
   * A normal token expires when its positive maxInactiveInterval is exceeded.
   * Missing tokens return null; other token states are preserved.
   */
  async getByToken(token: string): Promise<TokenInfo | null> {
    const info = this.tokens.get(token) || null;
    if (!info) return null;

    // checkTimeout: auto-expire inactive tokens
    if (
      info.maxInactiveInterval &&
      info.maxInactiveInterval > 0 &&
      info.state === TokenState.NORMAL &&
      Date.now() - info.lastRequestTime.getTime() > info.maxInactiveInterval
    ) {
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

  async touch(token: string): Promise<void> {
    const info = this.tokens.get(token);
    if (info) {
      info.lastRequestTime = new Date();
      info.requestTimes = (info.requestTimes || 0) + 1;
    }
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
   *   Flux.fromIterable(tokenStorage.values())
   *     .doOnNext(this::checkTimeout)     // marks as expired via changeTokenState
   *     .filter(UserToken::isExpired)
   *     .map(UserToken::getToken)
   *     .flatMap(this::signOutByToken)    // removes and publishes UserTokenRemovedEvent
   *     .then()
   */
  async checkExpired(): Promise<void> {
    const now = Date.now();
    // Snapshot keys to avoid mutation during iteration
    const entries = Array.from(this.tokens.entries());
    for (const [token, info] of entries) {
      if (
        info.maxInactiveInterval &&
        info.maxInactiveInterval > 0 &&
        now - info.lastRequestTime.getTime() > info.maxInactiveInterval
      ) {
        // Publish state change event first
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
    const tokenIds = this.userTokens.get(userId);
    if (!tokenIds) return;
    for (const token of Array.from(tokenIds)) {
      await this.blacklist(token);
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

  private pruneRevocations(): void {
    const now = Date.now();
    for (const [token, expiresAt] of this.revokedTokens) {
      if (expiresAt <= now) this.revokedTokens.delete(token);
    }
    for (const [userId, entry] of this.revokedAfter) {
      if (entry.expiresAt <= now) this.revokedAfter.delete(userId);
    }
  }

  private async blacklist(token: string): Promise<void> {
    if (this.cache) {
      await this.cache.set(`${BLACKLIST_PREFIX}${token}`, true, this.blacklistTtlMs);
    } else {
      this.pruneRevocations();
      this.revokedTokens.set(token, Date.now() + this.blacklistTtlMs);
    }
  }

  private removeSession(token: string): void {
    const info = this.tokens.get(token);
    if (!info) return;
    const userSet = this.userTokens.get(info.userId);
    userSet?.delete(token);
    if (userSet?.size === 0) this.userTokens.delete(info.userId);
  }

  private async markUserRevoked(userId: string): Promise<void> {
    const now = Date.now();
    if (this.cache) {
      await this.cache.set(`${REVOKED_AFTER_PREFIX}${userId}`, now, this.blacklistTtlMs);
    } else {
      this.pruneRevocations();
      this.revokedAfter.set(userId, { at: now, expiresAt: now + this.blacklistTtlMs });
    }
  }

  private async getUserRevokedAt(userId: string): Promise<number | undefined> {
    if (this.cache) {
      const value = await this.cache.get(`${REVOKED_AFTER_PREFIX}${userId}`);
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
    await this.checkExpired();
  }

  private async publishEvent(topic: string, payload: unknown): Promise<void> {
    if (this.topicEventBus) {
      await this.topicEventBus.publish(topic, payload);
    }
  }
}
