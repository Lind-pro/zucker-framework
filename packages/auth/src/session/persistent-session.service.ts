import type { DatabaseAdapter, ModelOperations } from '@zucker-framework/core';
import type { ICache } from '@zucker-framework/cache';

export interface PersistentSession {
  id: string;
  userId: string;
  refreshJti: string;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason?: string | null;
  lastActiveAt: Date;
}

export interface PersistentSessionOptions {
  /** Model with the PersistentSession fields; the consumer supplies its schema mapping. */
  modelName: string;
  sessionTtlMs: number;
  cache?: Pick<ICache, 'get' | 'set' | 'del'>;
  cachePrefix?: string;
  revokedTtlMs?: number;
  touchIntervalMs?: number;
}

/** Durable sessions. The database is authoritative; cache entries can only deny access. */
export class PersistentSessionService<T extends PersistentSession = PersistentSession> {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly options: PersistentSessionOptions,
  ) {}

  private model(db = this.db): ModelOperations<T> {
    return db.model(this.options.modelName) as ModelOperations<T>;
  }

  private key(kind: string, id: string): string {
    return `${this.options.cachePrefix ?? 'session:'}${kind}:${id}`;
  }

  private async cached(kind: string, id: string): Promise<boolean> {
    try {
      return (await this.options.cache?.get(this.key(kind, id))) === '1';
    } catch {
      return false;
    }
  }

  private async cache(kind: string, id: string, ttlMs: number): Promise<void> {
    if (ttlMs <= 0) return;
    try {
      await this.options.cache?.set(this.key(kind, id), '1', ttlMs);
    } catch {
      /* Cache failure must not undo a durable revocation or prevent a DB check. */
    }
  }

  createSession(input: Pick<T, 'userId' | 'refreshJti'> & Partial<T>): Promise<T> {
    return this.model().create({
      data: {
        ...input,
        expiresAt: input.expiresAt ?? new Date(Date.now() + this.options.sessionTtlMs),
      },
    });
  }

  async isSessionRevoked(sessionId: string): Promise<boolean> {
    if (await this.cached('revoked', sessionId)) return true;
    const session = await this.model().findUnique({
      where: { id: sessionId },
      select: { revokedAt: true, expiresAt: true },
    });
    const revoked = !session || !!session.revokedAt || session.expiresAt.getTime() <= Date.now();
    if (revoked) await this.cache('revoked', sessionId, this.options.revokedTtlMs ?? 3_600_000);
    return revoked;
  }

  getSessionByRefreshJti(refreshJti: string): Promise<T | null> {
    return this.model().findUnique({ where: { refreshJti } });
  }

  getSessionById(sessionId: string): Promise<T | null> {
    return this.model().findUnique({ where: { id: sessionId } });
  }

  /** Initialize token transport for an already-created session; a revoked session cannot be revived. */
  async replaceRefreshJti(sessionId: string, refreshJti: string): Promise<boolean> {
    const changed = await this.model().updateMany({
      where: { id: sessionId, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { refreshJti },
    });
    return changed.count === 1;
  }

  async getSessionByRefreshJtiOrId(idOrJti: string): Promise<T | null> {
    const sessions = await this.model().findMany({
      where: { OR: [{ id: idOrJti }, { refreshJti: idOrJti }] },
      take: 1,
    });
    return sessions[0] ?? null;
  }

  /** Compare-and-swap prevents a replay or simultaneous refresh from succeeding twice. */
  async rotateRefreshJti(
    sessionId: string,
    currentRefreshJti: string,
    nextRefreshJti: string,
  ): Promise<boolean> {
    if (currentRefreshJti === nextRefreshJti) return false;
    const result = await this.model().updateMany({
      where: {
        id: sessionId,
        refreshJti: currentRefreshJti,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      // The rotation time bounds the refresh-token reuse grace window.
      data: { refreshJti: nextRefreshJti, lastActiveAt: new Date() },
    });
    return result.count === 1;
  }

  async revokeSession(sessionId: string, reason: string): Promise<void> {
    await this.model().update({
      where: { id: sessionId },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    await this.cache('revoked', sessionId, this.options.revokedTtlMs ?? 3_600_000);
  }

  /** Revoke only a session belonging to the authenticated owner in one conditional write. */
  async revokeSessionForUser(sessionId: string, userId: string, reason: string): Promise<boolean> {
    const changed = await this.model().updateMany({
      where: { id: sessionId, userId },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    if (changed.count !== 1) return false;
    await this.cache('revoked', sessionId, this.options.revokedTtlMs ?? 3_600_000);
    return true;
  }

  async revokeAllOtherSessions(
    userId: string,
    exceptSessionId: string | null,
    reason: string,
  ): Promise<number> {
    const targets = await this.db.$transaction(async (db) => {
      const model = this.model(db);
      const sessions = await model.findMany({
        where: {
          userId,
          revokedAt: null,
          ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
        },
        select: { id: true },
      });
      if (sessions.length)
        await model.updateMany({
          where: { id: { in: sessions.map((s) => s.id) } },
          data: { revokedAt: new Date(), revokedReason: reason },
        });
      return sessions;
    });
    await Promise.all(
      targets.map((s) => this.cache('revoked', s.id, this.options.revokedTtlMs ?? 3_600_000)),
    );
    return targets.length;
  }

  listUserSessions(userId: string): Promise<T[]> {
    return this.model().findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastActiveAt: 'desc' },
    });
  }

  async throttledTouchLastActive(sessionId: string): Promise<void> {
    if (await this.cached('lastactive', sessionId)) return;
    await this.model().update({ where: { id: sessionId }, data: { lastActiveAt: new Date() } });
    await this.cache('lastactive', sessionId, this.options.touchIntervalMs ?? 300_000);
  }
}
