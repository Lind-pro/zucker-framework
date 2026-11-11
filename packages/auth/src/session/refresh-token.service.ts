import { randomUUID } from 'node:crypto';

export class RefreshTokenError extends Error {
  constructor(readonly reason: 'invalid' | 'replayed' | 'identity-missing') {
    super(`Refresh token rejected: ${reason}`);
    this.name = 'RefreshTokenError';
  }
}

export interface RefreshTokenClaims { subject: string; jti: string }
export interface RefreshTokenPair { accessToken: string; refreshToken: string }

/** All writes must serialize on subject, including login and logout. No table is required. */
export interface RefreshTokenStore {
  replace(subject: string, jti: string, ttlMs: number): Promise<void>;
  /** Advisory preflight to reject known replays before loading identity/signing. */
  canRotate(subject: string, current: string, allowMissing: boolean): Promise<boolean>;
  /** Atomic compare-and-swap, including the optional missing-key recovery branch. */
  rotate(subject: string, current: string, next: string, ttlMs: number, allowMissing: boolean): Promise<boolean>;
  /** Keep a denial tombstone, not a missing key that legacy recovery can resurrect. */
  revoke(subject: string, ttlMs: number): Promise<void>;
  /**
   * Reuse detection (optional): a correctly signed refresh token that is no longer current was
   * presented. Revoke the subject (and with it the current successor token and the access tokens a
   * consumer binds to it) unless its last rotation is younger than `graceMs` (a lost response retried
   * by the client); an already revoked, expired or missing subject is left alone. Returns true when it
   * revoked. Stores without it keep the plain rejection.
   */
  reused?(subject: string, jti: string, graceMs: number): Promise<boolean>;
}

export interface RefreshTokenOptions<Identity> {
  store: RefreshTokenStore;
  /** Verify signature, expiry, algorithm and token type before returning normalized claims. */
  verify(token: string): Promise<RefreshTokenClaims> | RefreshTokenClaims;
  /** Reload current identity/permissions; never authorize using stale JWT claims. */
  loadIdentity(subject: string): Promise<Identity | null>;
  issue(identity: Identity, claims: RefreshTokenClaims, lifetime: {
    accessTtlSeconds: number; refreshTtlSeconds: number;
  }): Promise<RefreshTokenPair> | RefreshTokenPair;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  /** Explicit legacy compatibility. Eviction/restart can re-admit old JWTs with this policy. */
  cacheMissPolicy?: 'reject' | 'recover';
  createJti?: () => string;
  /**
   * Refresh-token reuse detection (stores implementing `reused`). Default `{ graceMs: 10_000 }`:
   * presenting an already rotated token revokes the subject unless it was rotated within the grace
   * window. The grace window never grants access; it only spares a client retrying a lost response
   * from being signed out. A request that loses a concurrent rotation race is rejected without
   * revocation. `false` restores the plain rejection.
   */
  reuseDetection?: false | { graceMs?: number };
}

/** Pair lifecycle independent of wire format, account policy, ORM and transport. */
export class RefreshTokenService<Identity> {
  constructor(private readonly options: RefreshTokenOptions<Identity>) {
    for (const ttl of [options.accessTtlSeconds, options.refreshTtlSeconds]) {
      if (!Number.isSafeInteger(ttl) || ttl <= 0 || !Number.isSafeInteger(ttl * 1000)) {
        throw new RangeError('Token lifetimes must be positive safe integer seconds');
      }
    }
    const grace = options.reuseDetection === false ? undefined : options.reuseDetection?.graceMs;
    if (grace !== undefined && (!Number.isSafeInteger(grace) || grace < 0)) {
      throw new RangeError('reuseDetection.graceMs must be a non-negative integer of milliseconds');
    }
  }

  async login(subject: string, identity: Identity): Promise<RefreshTokenPair> {
    this.requireValue(subject);
    const claims = { subject, jti: this.nextJti() };
    const pair = await this.issue(identity, claims);
    await this.options.store.replace(subject, claims.jti, this.ttlMs);
    return pair;
  }

  async refresh(token: string): Promise<RefreshTokenPair> {
    this.requireValue(token);
    const claims = await this.options.verify(token);
    if (!claims || typeof claims !== 'object') throw new RefreshTokenError('invalid');
    this.requireValue(claims.subject);
    this.requireValue(claims.jti);
    const allowMissing = this.options.cacheMissPolicy === 'recover';
    if (!await this.options.store.canRotate(claims.subject, claims.jti, allowMissing)) {
      // Already rotated before this request started: a reused (possibly stolen) token.
      const { store, reuseDetection } = this.options;
      if (reuseDetection !== false && store.reused) {
        await store.reused(claims.subject, claims.jti, reuseDetection?.graceMs ?? 10_000);
      }
      throw new RefreshTokenError('replayed');
    }
    const identity = await this.options.loadIdentity(claims.subject);
    if (identity === null) throw new RefreshTokenError('identity-missing');
    const next = this.nextJti();
    if (next === claims.jti) throw new RefreshTokenError('invalid');
    // Prepare before CAS: signer/loader failure leaves the previous token usable.
    // A losing concurrent request must never return its prepared pair.
    const pair = await this.issue(identity, { subject: claims.subject, jti: next });
    // Losing a concurrent rotation of the same token is a double submit, not reuse: reject only.
    if (!await this.options.store.rotate(claims.subject, claims.jti, next, this.ttlMs,
      allowMissing)) throw new RefreshTokenError('replayed');
    return pair;
  }

  /** Call only for an authenticated subject (not an unverified request body/JWT). */
  async revoke(subject: string): Promise<void> {
    this.requireValue(subject);
    await this.options.store.revoke(subject, this.ttlMs);
  }

  private get ttlMs(): number { return this.options.refreshTtlSeconds * 1000; }
  private requireValue(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !value.trim()) throw new RefreshTokenError('invalid');
  }
  private nextJti(): string {
    const jti = (this.options.createJti ?? randomUUID)();
    this.requireValue(jti);
    return jti;
  }
  private async issue(identity: Identity, claims: RefreshTokenClaims): Promise<RefreshTokenPair> {
    const pair = await this.options.issue(identity, claims, {
      accessTtlSeconds: this.options.accessTtlSeconds,
      refreshTtlSeconds: this.options.refreshTtlSeconds,
    });
    this.requireValue(pair?.accessToken);
    this.requireValue(pair?.refreshToken);
    return pair;
  }
}

export interface RefreshTokenCache {
  get(key: string): Promise<unknown>;
  /** TTL is milliseconds; adapt second-based cache facades at the boundary. */
  set(key: string, value: string | { revoked: true }, ttlMs: number): Promise<unknown>;
}
export interface RefreshTokenLock {
  /** Must serialize all writers for key across the entire cache's sharing scope. */
  runExclusive<T>(key: string, work: () => Promise<T>): Promise<T>;
}

/** Only for a process-local cache; deliberately not a distributed-lock fallback. */
export class InProcessRefreshTokenLock implements RefreshTokenLock {
  private readonly tails = new Map<string, Promise<void>>();
  async runExclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(key, tail);
    await previous;
    try { return await work(); }
    finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

/** Keeps legacy string JTI values and consumer-defined keys. Cache errors propagate. */
export class CacheRefreshTokenStore implements RefreshTokenStore {
  constructor(private readonly options: {
    cache: RefreshTokenCache;
    key(subject: string): string;
    lock: RefreshTokenLock;
  }) {}

  async replace(subject: string, jti: string, ttlMs: number): Promise<void> {
    const key = this.options.key(subject);
    await this.options.lock.runExclusive(key, async () => {
      await this.options.cache.set(key, jti, ttlMs);
    });
  }
  async canRotate(subject: string, current: string, allowMissing: boolean): Promise<boolean> {
    const stored = await this.options.cache.get(this.options.key(subject));
    return stored === null || stored === undefined ? allowMissing : stored === current;
  }
  async rotate(subject: string, current: string, next: string, ttlMs: number, allowMissing: boolean): Promise<boolean> {
    const key = this.options.key(subject);
    return this.options.lock.runExclusive(key, async () => {
      if (current === next || !await this.canRotate(subject, current, allowMissing)) return false;
      await this.options.cache.set(key, next, ttlMs);
      return true;
    });
  }
  async revoke(subject: string, ttlMs: number): Promise<void> {
    const key = this.options.key(subject);
    await this.options.lock.runExclusive(key, async () => {
      await this.options.cache.set(key, { revoked: true }, ttlMs);
    });
  }
}
