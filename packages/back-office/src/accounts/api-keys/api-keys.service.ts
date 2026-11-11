import { BadRequestException, ForbiddenException, Inject, Injectable, Optional, UnauthorizedException, type CanActivate, type ExecutionContext, type Provider } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiKeyGuard, ApiKeyService } from '@zucker-framework/auth';
import { DATABASE_ADAPTER, type DatabaseAdapter } from '@zucker-framework/core';
import { RateLimiterService, TooManyRequestsException } from '@zucker-framework/rate-limiter';
import { ACCOUNT_API_KEY_SCOPES } from '../account.guard';
import { resolveAccountsOptions, type ResolvedAccountsFeatures, type ResolvedAccountsOptions } from '../accounts.options';
import { ACCOUNTS_OPTIONS } from '../accounts.tokens';
import { API_KEY_LIMITER } from '../rate-limits';

type ApiKeysFeature = NonNullable<ResolvedAccountsFeatures['apiKeys']>;
function apiKeysFeature(options: ResolvedAccountsOptions | undefined): ApiKeysFeature {
  return (options ?? resolveAccountsOptions({ features: { apiKeys: true } })).features.apiKeys
    ?? resolveAccountsOptions({ features: { apiKeys: true } }).features.apiKeys!;
}

/** `ApiKeyService` over the configured key models, prefix, scopes and the `api-key` limiter. */
export const ACCOUNT_API_KEY_SERVICE_PROVIDER: Provider = {
  provide: ApiKeyService,
  inject: [DATABASE_ADAPTER, RateLimiterService, { token: ACCOUNTS_OPTIONS, optional: true }],
  useFactory: (db: DatabaseAdapter, limiter: RateLimiterService, options?: ResolvedAccountsOptions) => {
    const resolved = options ?? resolveAccountsOptions({ features: { apiKeys: true } });
    const feature = apiKeysFeature(resolved);
    return new ApiKeyService(db, {
      modelName: resolved.models.accountApiKeys, usageModelName: resolved.models.accountApiKeyUsage, keyPrefix: feature.keyPrefix,
      defaultScopes: [...feature.scopes], defaultRateLimit: feature.rateLimit,
      consumeRateLimit: async (keyId, limit) => {
        const result = await limiter.checkLimit(API_KEY_LIMITER, keyId, limit);
        if (!result.allowed) throw new TooManyRequestsException('API key rate limit exceeded', Math.max(1, Math.ceil((result.resetAt.getTime() - Date.now()) / 1000)));
        return result;
      },
    });
  },
};

/** Self-service API keys of the signed-in account (`/authorize/api-keys`) and the key-authenticated profile. */
@Injectable()
export class AccountApiKeysService {
  readonly feature: ApiKeysFeature;
  private readonly usersModel: string;
  constructor(private readonly keys: ApiKeyService, @Inject(DATABASE_ADAPTER) private readonly db: DatabaseAdapter,
    @Optional() @Inject(ACCOUNTS_OPTIONS) options?: ResolvedAccountsOptions) {
    this.feature = apiKeysFeature(options);
    this.usersModel = (options ?? resolveAccountsOptions()).models.users;
  }

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
    // Spending scopes are opt-in; a key created without scopes gets only the default (read) scopes.
    const scopes = input.scopes === undefined ? [...this.feature.defaultScopes] : input.scopes;
    if (!Array.isArray(scopes) || !scopes.length || scopes.length > this.feature.scopes.length ||
      scopes.some(scope => typeof scope !== 'string' || !this.feature.scopes.includes(scope))) {
      throw new BadRequestException('Unsupported API key scopes');
    }
    const days = input.expiresInDays ?? 30;
    if (typeof days !== 'number' || !this.feature.expiryDays.includes(days)) throw new BadRequestException('Invalid API key expiry');
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
    const user = await this.db.model(this.usersModel).findUnique({ where: { id: userId },
      select: { id: true, username: true, name: true, email: true, emailVerified: true, status: true } }) as {
        id: string; username: string; name: string; email: string | null; emailVerified: boolean; status: boolean;
      } | null;
    if (!user?.status) throw new UnauthorizedException('Account is unavailable');
    const { status: _status, ...profile } = user; return profile;
  }
}

/** API-key authentication of `@AccountApiKeyScopes(...)` routes; never a JWT fallback. Register as `ACCOUNTS_API_KEY_AUTHENTICATOR`. */
@Injectable()
export class AccountApiKeyAuthenticator implements CanActivate {
  private readonly guard: ApiKeyGuard;
  constructor(@Inject(ApiKeyService) keys: ApiKeyService, private readonly reflector: Reflector, private readonly accounts: AccountApiKeysService) {
    this.guard = new ApiKeyGuard(keys); // Missing keys fail closed.
  }
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[]>(ACCOUNT_API_KEY_SCOPES, [context.getHandler(), context.getClass()]);
    if (!required?.length || required.some(scope => !this.accounts.feature.scopes.includes(scope))) {
      throw new ForbiddenException('API key scope is not configured');
    }
    await this.guard.canActivate(context);
    const request = context.switchToHttp().getRequest<{ user: { id: string; username?: string }; apiKey: { scopes: string[] } }>();
    if (!required.every(scope => request.apiKey.scopes.includes(scope))) throw new ForbiddenException('API key scope is insufficient');
    const user = await this.accounts.ownProfile(request.user.id);
    request.user = { id: user.id, username: user.username };
    return true;
  }
}
