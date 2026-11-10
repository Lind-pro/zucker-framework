import { BadRequestException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ApiKeyService } from '@zucker-framework/auth';
import { DATABASE_ADAPTER, type DatabaseAdapter } from '@zucker-framework/core';

/** `ai:generate` admits `/v1/ai/tasks*` (AI_GENERATE_SCOPE in ../ai-tasks). */
export const ACCOUNT_KEY_SCOPES = ['account:read', 'ai:generate'] as const;
export const ACCOUNT_KEY_EXPIRY_DAYS = [7, 30, 90, 365] as const;

@Injectable()
export class AccountApiKeysService {
  constructor(private readonly keys: ApiKeyService, @Inject(DATABASE_ADAPTER) private readonly db: DatabaseAdapter) {}

  async list(userId: string) {
    const now = new Date();
    return { apiKeys: (await this.keys.getUserApiKeys(userId)).map(key => ({ ...key,
      canRename: key.isActive && (!key.expiresAt || key.expiresAt > now) })) };
  }
  async create(userId: string, body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Invalid API key request');
    const input = body as Record<string, unknown>;
    if (Object.keys(input).some(key => !['name', 'scopes', 'expiresInDays'].includes(key))) throw new BadRequestException('Unsupported API key fields');
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 80 || /[\u0000-\u001f]/.test(name)) throw new BadRequestException('Invalid API key name');
    // Spending scopes (ai:generate) are opt-in; a key created without scopes can only read the account.
    const scopes = input.scopes === undefined ? ['account:read'] : input.scopes;
    if (!Array.isArray(scopes) || !scopes.length || scopes.length > ACCOUNT_KEY_SCOPES.length ||
      scopes.some(scope => typeof scope !== 'string' || !ACCOUNT_KEY_SCOPES.includes(scope as typeof ACCOUNT_KEY_SCOPES[number]))) {
      throw new BadRequestException('Unsupported API key scopes');
    }
    const days = input.expiresInDays ?? 30;
    if (typeof days !== 'number' || !ACCOUNT_KEY_EXPIRY_DAYS.includes(days as typeof ACCOUNT_KEY_EXPIRY_DAYS[number])) throw new BadRequestException('Invalid API key expiry');
    return this.keys.createApiKey({ userId, name, scopes: [...new Set(scopes)] as string[], expiresAt: new Date(Date.now() + days * 86400_000) });
  }
  async revoke(userId: string, id: string) {
    if (!id || id.length > 128) throw new BadRequestException('Invalid API key identifier');
    await this.keys.revokeApiKey(id, userId); return { success: true };
  }
  async rename(userId: string, id: string, body: unknown) {
    if (!id || id.length > 128 || !body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'name')) throw new BadRequestException('Invalid API key rename');
    const input = body as { name?: unknown }, name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 80 || /[\u0000-\u001f]/.test(name)) throw new BadRequestException('Invalid API key name');
    return this.keys.renameApiKey(id, userId, name);
  }
  async ownProfile(userId: string) {
    const user = await this.db.model('users').findUnique({ where: { id: userId },
      select: { id: true, username: true, name: true, email: true, emailVerified: true, status: true } }) as {
        id: string; username: string; name: string; email: string | null; emailVerified: boolean; status: boolean;
      } | null;
    if (!user?.status) throw new UnauthorizedException('Account is unavailable');
    const { status: _status, ...profile } = user; return profile;
  }
}
