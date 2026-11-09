import { BadRequestException, ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { DATABASE_ADAPTER, type DatabaseAdapter, type ModelOperations } from '@zucker-framework/core';
import {
  DatabaseOneTimeTicketStore, OneTimeTicketService, OneTimeTicketError,
  PersistentSessionService, PersistentSessionRefreshTokenStore, RefreshTokenService, RefreshTokenError,
  UserService, type UserEntity, type OneTimeTicketRecord, type RefreshTokenPair, type PersistentSession,
} from '@zucker-framework/auth';

export const ACCOUNT_MAILER = Symbol('ACCOUNT_MAILER');
export interface AccountMailer {
  assertConfigured(): void;
  send(email: string, purpose: 'verify-email' | 'reset-password', ticket: string, locale: string): Promise<void>;
}
interface AccountTicket extends OneTimeTicketRecord {
  userId: string;
  email: string;
  purpose: 'verify-email' | 'reset-password';
  credentialVersion: number;
}
export interface AccountSession extends PersistentSession { credentialVersion: number; authMethod?: string; oauthBindingId?: string | null }
export const ACCESS_TTL_SECONDS = 900;
export const SESSION_TTL_SECONDS = 30 * 86400;

function fields(body: unknown, keys: string[]): Record<string, string> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Invalid request');
  const entries = Object.entries(body);
  if (entries.some(([key, value]) => !keys.includes(key) || typeof value !== 'string' || value.length > 2048)) {
    throw new BadRequestException('Invalid request fields');
  }
  return Object.fromEntries(entries) as Record<string, string>;
}
function emailAddress(value: string | undefined): string {
  const email = value?.trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException('Invalid email');
  return email;
}

/** Consumer composition: public account policy, schema mapping and mail copy stay in this template. */
@Injectable()
export class AccountService {
  readonly sessions: PersistentSessionService<AccountSession>;
  private readonly tokens: RefreshTokenService<UserEntity>;

  constructor(
    @Inject(DATABASE_ADAPTER) private readonly db: DatabaseAdapter,
    private readonly users: UserService,
    private readonly jwt: JwtService,
    @Inject(ACCOUNT_MAILER) private readonly mailer: AccountMailer,
  ) {
    this.sessions = new PersistentSessionService<AccountSession>(db, { modelName: 'accountSessions', sessionTtlMs: SESSION_TTL_SECONDS * 1000 });
    this.tokens = new RefreshTokenService({
      store: new PersistentSessionRefreshTokenStore(this.sessions),
      accessTtlSeconds: ACCESS_TTL_SECONDS,
      refreshTtlSeconds: SESSION_TTL_SECONDS,
      verify: async token => {
        try {
          const claims = await jwt.verifyAsync(token, { algorithms: ['HS256'], audience: 'zucker:refresh' });
          if (claims.tokenUse !== 'refresh') throw new RefreshTokenError('invalid');
          return { subject: claims.sub, jti: claims.jti };
        } catch { throw new RefreshTokenError('invalid'); }
      },
      loadIdentity: async sessionId => {
        const session = await this.sessions.getSessionById(sessionId);
        const user = session && await users.findById(session.userId);
        return session && user && await this.sessionIdentityAllowed(session, user) ? user : null;
      },
      issue: async (user, claims, lifetime) => ({
        accessToken: await jwt.signAsync({ sub: user.id, username: user.username, sid: claims.subject, tokenUse: 'access' },
          { algorithm: 'HS256', expiresIn: lifetime.accessTtlSeconds, audience: 'zucker:access' }),
        refreshToken: await jwt.signAsync({ sub: claims.subject, jti: claims.jti, tokenUse: 'refresh' },
          { algorithm: 'HS256', expiresIn: lifetime.refreshTtlSeconds, audience: 'zucker:refresh' }),
      }),
    });
  }

  private tickets(db = this.db) {
    return new OneTimeTicketService(new DatabaseOneTimeTicketStore(db.model('accountTickets') as ModelOperations<AccountTicket>), {
      expirySeconds: 1800, consumedRetentionSeconds: 86400,
    });
  }

  async register(body: unknown): Promise<{ verificationRequired: true }> {
    const input = fields(body, ['username', 'email', 'password', 'locale']);
    const email = emailAddress(input.email);
    if (!input.username || !input.password) throw new BadRequestException('Username and password are required');
    const locale = input.locale === 'zh' ? 'zh' : 'en';
    this.mailer.assertConfigured();
    let user: UserEntity;
    try {
      user = await this.db.$transaction(async tx => {
        const existing = await tx.model('users').findMany({ where: { OR: [{ email }, { username: input.username }] }, take: 1 });
        if (existing.length) throw new ConflictException('Account already exists');
        return new UserService(tx).addUser({
          username: input.username, password: input.password, email, locale,
          name: input.username, typeId: 'member', status: true, emailVerified: false,
        });
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') throw new ConflictException('Account already exists');
      throw error;
    }
    await this.deliverTicket(user, 'verify-email');
    return { verificationRequired: true };
  }

  private async deliverTicket(user: UserEntity, purpose: AccountTicket['purpose']): Promise<void> {
    if (!user.email) return;
    const code = await this.tickets().issue({ userId: user.id, email: user.email, purpose, credentialVersion: Number(user.credentialVersion ?? 0) });
    await this.mailer.send(user.email, purpose, code, user.locale ?? 'en');
  }

  async requestEmail(body: unknown, purpose: AccountTicket['purpose']): Promise<{ accepted: true }> {
    const input = fields(body, ['email']);
    const email = emailAddress(input.email);
    this.mailer.assertConfigured();
    const rows = await this.db.model('users').findMany({ where: { email }, take: 1 }) as UserEntity[];
    const user = rows[0];
    if (user?.status && (purpose === 'reset-password' || !user.emailVerified)) await this.deliverTicket(user, purpose);
    return { accepted: true };
  }

  async consumeEmail(body: unknown, purpose: AccountTicket['purpose']): Promise<{ success: true }> {
    const input = fields(body, purpose === 'reset-password' ? ['ticket', 'password'] : ['ticket']);
    if (!input.ticket || !/^[A-Za-z0-9_-]{43}$/.test(input.ticket)) throw new BadRequestException('Invalid ticket');
    if (purpose === 'reset-password' && !input.password) throw new BadRequestException('Password is required');
    try {
      await this.db.$transaction(async tx => {
        const ticket = await this.tickets(tx).consume(input.ticket);
        const user = await new UserService(tx).findById(ticket.userId);
        if (ticket.purpose !== purpose || !user?.status || user.email !== ticket.email
          || ticket.credentialVersion !== Number(user.credentialVersion ?? 0)) throw new OneTimeTicketError('invalid');
        if (purpose === 'verify-email') {
          await tx.model('users').update({ where: { id: user.id }, data: { emailVerified: true } });
        } else {
          await this.replacePassword(tx, user, input.password, 'password-reset');
        }
      });
    } catch (error) {
      if (error instanceof OneTimeTicketError) throw new BadRequestException('Invalid or expired ticket');
      throw error;
    }
    return { success: true };
  }

  private async replacePassword(tx: DatabaseAdapter, user: UserEntity, password: string, reason: string): Promise<void> {
    const changed = await tx.model('users').updateMany({
      where: { id: user.id, credentialVersion: Number(user.credentialVersion ?? 0) },
      data: { credentialVersion: { increment: 1 } },
    });
    if (changed.count !== 1) throw new OneTimeTicketError('invalid');
    await new UserService(tx).updateUser(user.id, { password });
    await tx.model('accountSessions').updateMany({ where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason } });
  }

  async changePassword(userId: string, body: unknown): Promise<{ success: true }> {
    const input = fields(body, ['currentPassword', 'password']);
    if (!input.currentPassword || !input.password) throw new BadRequestException('Current and new password are required');
    await this.db.$transaction(async tx => {
      const users = new UserService(tx);
      const current = await users.findById(userId);
      const checked = current && await users.findByUsernameAndPassword(current.username, input.currentPassword);
      if (!checked?.status) throw new UnauthorizedException('Invalid current password');
      await this.replacePassword(tx, checked, input.password, 'password-change');
    });
    return { success: true };
  }

  async updateProfile(userId: string, body: unknown): Promise<{ success: true }> {
    const input = fields(body, ['name', 'locale']);
    if (input.name !== undefined && (!input.name.trim() || input.name.length > 100)) throw new BadRequestException('Invalid name');
    if (input.locale !== undefined && !['en', 'zh'].includes(input.locale)) throw new BadRequestException('Invalid locale');
    await this.users.updateUser(userId, input);
    return { success: true };
  }

  async login(body: unknown): Promise<RefreshTokenPair & { userId: string }> {
    const input = fields(body, ['username', 'password']);
    if (!input.username || !input.password) throw new BadRequestException('Username and password are required');
    const user = await this.users.findByUsernameAndPassword(input.username, input.password);
    if (!user?.status || !user.emailVerified) throw new UnauthorizedException('Invalid credentials or email not verified');
    return this.openSession(user, 'password');
  }

  private async openSession(user: UserEntity, authMethod: 'password' | 'oauth', oauthBindingId?: string): Promise<RefreshTokenPair & { userId: string }> {
    const session = await this.sessions.createSession({ id: randomUUID(), userId: user.id, refreshJti: randomUUID(),
      revokedAt: null, lastActiveAt: new Date(), credentialVersion: Number(user.credentialVersion ?? 0), authMethod,
      oauthBindingId: oauthBindingId ?? null });
    try {
      return { ...await this.tokens.login(session.id, user), userId: user.id };
    } catch (error) {
      await this.sessions.revokeSession(session.id, 'login-failed');
      throw error;
    }
  }

  async providerLogin(userId: string, bindingId: string): Promise<RefreshTokenPair & { userId: string }> {
    const user = await this.users.findById(userId);
    const binding = await this.db.model('thirdPartyBinds').findUnique({ where: { id: bindingId } }) as { userId: string } | null;
    if (!user?.status || binding?.userId !== userId) throw new UnauthorizedException('Provider account is unavailable');
    return this.openSession(user, 'oauth', bindingId);
  }

  private async sessionIdentityAllowed(session: AccountSession, user: UserEntity, db = this.db): Promise<boolean> {
    if (!user.status || session.credentialVersion !== Number(user.credentialVersion ?? 0)) return false;
    if (session.authMethod === 'oauth') {
      if (!session.oauthBindingId) return false;
      const binding = await db.model('thirdPartyBinds').findUnique({ where: { id: session.oauthBindingId } }) as { userId: string } | null;
      return binding?.userId === user.id;
    }
    return (session.authMethod === undefined || session.authMethod === 'password') && user.emailVerified === true;
  }

  /** Read the current HttpOnly session without rotating it, for browser-bound OAuth callbacks. */
  async browserSession(token: string): Promise<{ id: string; sid: string }> {
    try {
      const claims = await this.jwt.verifyAsync(token, { algorithms: ['HS256'], audience: 'zucker:refresh' });
      if (claims.tokenUse !== 'refresh' || typeof claims.sub !== 'string') throw new Error();
      const session = await this.sessions.getSessionById(claims.sub);
      if (!session || session.refreshJti !== claims.jti) throw new Error();
      await this.currentUser(session.userId, session.id);
      return { id: session.userId, sid: session.id };
    } catch { throw new UnauthorizedException('Invalid or expired session'); }
  }

  /**
   * Session id of a correctly signed, unexpired refresh token that is still the session's current
   * token, or null. Used only as the per-session rate-limit key: a leaked, already rotated token
   * must not spend the victim session's budget (it stays on the per-IP network budget). refresh()
   * remains the authority on rotation and replay.
   */
  async refreshSessionId(token: string): Promise<string | null> {
    if (!token) return null;
    try {
      const claims = await this.jwt.verifyAsync(token, { algorithms: ['HS256'], audience: 'zucker:refresh' });
      if (claims.tokenUse !== 'refresh' || typeof claims.sub !== 'string' || !claims.sub) return null;
      const session = await this.sessions.getSessionById(claims.sub);
      return session && session.refreshJti === claims.jti ? claims.sub : null;
    } catch { return null; }
  }

  async refresh(token: string): Promise<RefreshTokenPair> {
    try { return await this.tokens.refresh(token); }
    catch (error) {
      if (error instanceof RefreshTokenError) throw new UnauthorizedException('Invalid or expired session');
      throw error;
    }
  }

  async currentUser(userId: string, sessionId: string, db = this.db): Promise<UserEntity> {
    const session = await db.model('accountSessions').findUnique({ where: { id: sessionId } }) as AccountSession | null;
    const user = await new UserService(db).findById(userId);
    if (!session || session.userId !== userId || session.revokedAt || session.expiresAt <= new Date() || !user
      || !await this.sessionIdentityAllowed(session, user, db)) {
      throw new UnauthorizedException('Invalid or expired session');
    }
    return user;
  }
}
