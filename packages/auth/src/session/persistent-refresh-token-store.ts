import type { PersistentSessionService } from './persistent-session.service';
import { RefreshTokenError, type RefreshTokenStore } from './refresh-token.service';

/**
 * Binds the existing token-pair lifecycle to durable sessions. The token subject
 * is a session ID, not a user ID, so each device can be revoked independently.
 * Create the owned session before login. Its database expiry is authoritative;
 * refresh never extends that fixed lifetime or resurrects a revoked session.
 */
export class PersistentSessionRefreshTokenStore implements RefreshTokenStore {
  constructor(private readonly sessions: PersistentSessionService) {}

  async replace(sessionId: string, jti: string, _ttlMs: number): Promise<void> {
    if (!await this.sessions.replaceRefreshJti(sessionId, jti)) throw new RefreshTokenError('invalid');
  }

  async canRotate(sessionId: string, current: string, _allowMissing: boolean): Promise<boolean> {
    const session = await this.sessions.getSessionById(sessionId);
    return !!session && !session.revokedAt && session.expiresAt.getTime() > Date.now()
      && session.refreshJti === current;
  }

  rotate(sessionId: string, current: string, next: string, _ttlMs: number, _allowMissing: boolean): Promise<boolean> {
    return this.sessions.rotateRefreshJti(sessionId, current, next);
  }

  /** Rotation stamps `lastActiveAt`; a reuse older than the grace window revokes the session. */
  async reused(sessionId: string, jti: string, graceMs: number): Promise<boolean> {
    const session = await this.sessions.getSessionById(sessionId);
    if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now() || session.refreshJti === jti) return false;
    if (Date.now() - new Date(session.lastActiveAt).getTime() < graceMs) return false;
    await this.sessions.revokeSession(sessionId, 'refresh_reuse');
    return true;
  }

  async revoke(sessionId: string, _ttlMs: number): Promise<void> {
    const session = await this.sessions.getSessionById(sessionId);
    if (session) await this.sessions.revokeSession(sessionId, 'logout');
  }
}
