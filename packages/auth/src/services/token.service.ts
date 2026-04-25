import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { BusinessException } from '@zucker/core';
import { TokenState, AllopatricLoginMode, type TokenInfo } from '../interfaces';
import type { ICache } from '@zucker/cache';
import {
  AUTH_EVENT_TOPICS,
  createTokenCreatedEvent,
  createTokenChangedEvent,
  createTokenRemovedEvent,
} from '../events';

/** Minimal TopicEventBus interface to avoid hard dependency on @zucker/event */
interface TopicEventBusLike {
  publish(topic: string, payload: unknown): Promise<void>;
}

export const TOKEN_CACHE = Symbol('TOKEN_CACHE');

/** Token 黑名单缓存 key 前缀 */
const BLACKLIST_PREFIX = 'token:blacklist:';
/** 用户活跃会话缓存 key 前缀 */
const USER_SESSIONS_PREFIX = 'token:sessions:';

export interface TokenServiceOptions {
  /** 最大并发会话数，0 表示不限制 */
  maxActiveSessions?: number;
  /** Token 黑名单 TTL（毫秒），默认 7 天 */
  blacklistTtlMs?: number;
  /** 异地登录模式 (mirrors hsweb AllopatricLoginMode) */
  allopatricLoginMode?: AllopatricLoginMode;
}

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  /** 内存中的 token 会话映射（兜底存储） */
  private readonly tokens = new Map<string, TokenInfo>();
  private readonly userTokens = new Map<string, Set<string>>();

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
    // Allopatric login mode handling (mirrors hsweb DefaultUserTokenManager)
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

    // Publish token created event (mirrors hsweb UserTokenCreatedEvent)
    await this.publishEvent(
      AUTH_EVENT_TOPICS.TOKEN_CREATED,
      createTokenCreatedEvent(token, userId, type),
    );

    return tokenInfo;
  }

  async signOut(token: string): Promise<void> {
    const info = this.tokens.get(token);
    if (info) {
      const userSet = this.userTokens.get(info.userId);
      userSet?.delete(token);
      if (userSet?.size === 0) {
        this.userTokens.delete(info.userId);
      }
      // Publish token removed event (mirrors hsweb UserTokenRemovedEvent)
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

    // 写入缓存黑名单
    if (this.cache) {
      await this.cache.set(
        `${BLACKLIST_PREFIX}${token}`,
        true,
        this.blacklistTtlMs,
      );
    }

    await this.signOut(token);
  }

  /** 撤销用户所有 token（强制登出） */
  async revokeUserTokens(userId: string): Promise<void> {
    const tokens = await this.getByUserId(userId);
    for (const tokenInfo of tokens) {
      await this.revokeToken(tokenInfo.token);
    }
    this.logger.log(`用户 ${userId} 的所有 token 已撤销`);
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

    // 签发新 token
    const newToken = this.jwtService.sign(payload);
    const tokenInfo = await this.signIn(oldInfo.userId, newToken);

    return { token: newToken, tokenInfo };
  }

  /** 检查 token 是否在黑名单中 */
  async isBlacklisted(token: string): Promise<boolean> {
    if (this.cache) {
      return this.cache.has(`${BLACKLIST_PREFIX}${token}`);
    }
    // 无缓存时检查内存状态
    const info = this.tokens.get(token);
    return info?.state === TokenState.DENY;
  }

  /**
   * Get token info, checking for timeout expiration first.
   * Mirrors hsweb DefaultUserTokenManager.getByToken which calls checkTimeout().
   *
   * Java reference:
   *   private Mono<UserToken> checkTimeout(UserToken detail) {
   *     if (detail.getMaxInactiveInterval() <= 0) return Mono.just(detail);
   *     if (System.currentTimeMillis() - detail.getLastRequestTime() > detail.getMaxInactiveInterval()) {
   *       return changeTokenState(detail, TokenState.expired).thenReturn(detail);
   *     }
   *     return Mono.just(detail);
   *   }
   */
  async getByToken(token: string): Promise<TokenInfo | null> {
    const info = this.tokens.get(token) || null;
    if (!info) return null;

    // checkTimeout: auto-expire inactive tokens (mirrors hsweb checkTimeout)
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

  async changeState(token: string, state: TokenState): Promise<void> {
    const info = this.tokens.get(token);
    if (info) {
      const oldState = info.state;
      info.state = state;
      // Publish token changed event (mirrors hsweb UserTokenChangedEvent)
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

  /** Check if a user has any active (normal) sessions. Mirrors hsweb UserTokenManager.userIsLoggedIn */
  async userIsLoggedIn(userId: string): Promise<boolean> {
    const tokens = await this.getByUserId(userId);
    return tokens.some((t) => t.state === TokenState.NORMAL);
  }

  /** Check if a specific token is logged in (normal state). Mirrors hsweb UserTokenManager.tokenIsLoggedIn */
  async tokenIsLoggedIn(token: string): Promise<boolean> {
    const info = await this.getByToken(token);
    return info?.state === TokenState.NORMAL;
  }

  /** Total number of unique logged-in users. Mirrors hsweb UserTokenManager.totalUser */
  async totalUsers(): Promise<number> {
    return this.userTokens.size;
  }

  /** Get all active tokens. Mirrors hsweb UserTokenManager.allLoggedUser */
  async allLoggedTokens(): Promise<TokenInfo[]> {
    return Array.from(this.tokens.values());
  }

  /** Change state for all tokens of a user. Mirrors hsweb UserTokenManager.changeUserState */
  async changeUserState(userId: string, state: TokenState): Promise<void> {
    const tokens = await this.getByUserId(userId);
    for (const tokenInfo of tokens) {
      await this.changeState(tokenInfo.token, state);
    }
  }

  /**
   * Check all tokens for expiration, expire timed-out ones and remove them.
   *
   * Mirrors hsweb DefaultUserTokenManager.checkExpiredToken():
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
        // Publish state change event first (mirrors hsweb checkTimeout -> changeTokenState)
        await this.changeState(token, TokenState.EXPIRED);
      }
    }
    // Now remove all expired tokens (mirrors hsweb filter(isExpired) -> signOutByToken)
    for (const [token, info] of Array.from(this.tokens.entries())) {
      if (info.state === TokenState.EXPIRED) {
        await this.signOut(token);
      }
    }
  }

  async signOutByUserId(userId: string): Promise<void> {
    const tokenIds = this.userTokens.get(userId);
    if (!tokenIds) return;
    for (const token of Array.from(tokenIds)) {
      // Publish token removed event for each token (mirrors hsweb UserTokenRemovedEvent)
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

  private async publishEvent(topic: string, payload: unknown): Promise<void> {
    if (this.topicEventBus) {
      await this.topicEventBus.publish(topic, payload);
    }
  }
}
