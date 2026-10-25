import { Global, Module } from '@nestjs/common';
import { ApiKeyService } from '@zucker-framework/auth';
import { DATABASE_ADAPTER, type DatabaseAdapter } from '@zucker-framework/core';
import { RateLimiterService, TooManyRequestsException } from '@zucker-framework/rate-limiter';
import { ACCOUNT_API_KEY_AUTHENTICATOR } from '../accounts/api-key-authentication';
import { AccountApiKeyAuthenticator } from './api-key-authenticator';
import { AccountApiKeysService, ACCOUNT_KEY_SCOPES } from './api-keys.service';
import { AccountApiKeysController, ApiKeyAccountController } from './api-keys.controller';

@Global()
@Module({
  controllers: [AccountApiKeysController, ApiKeyAccountController],
  providers: [
    { provide: ApiKeyService, inject: [DATABASE_ADAPTER, RateLimiterService], useFactory: (db: DatabaseAdapter, limiter: RateLimiterService) => new ApiKeyService(db, {
      modelName: 'accountApiKeys', usageModelName: 'accountApiKeyUsage', keyPrefix: 'zk_api_', defaultScopes: [...ACCOUNT_KEY_SCOPES], defaultRateLimit: 60,
      consumeRateLimit: async (keyId, limit) => {
        const result = await limiter.checkLimit('api-key', keyId, limit);
        if (!result.allowed) throw new TooManyRequestsException('API key rate limit exceeded', Math.max(1, Math.ceil((result.resetAt.getTime() - Date.now()) / 1000)));
        return result;
      },
    }) },
    AccountApiKeysService, AccountApiKeyAuthenticator,
    { provide: ACCOUNT_API_KEY_AUTHENTICATOR, useExisting: AccountApiKeyAuthenticator },
  ],
  exports: [ACCOUNT_API_KEY_AUTHENTICATOR],
})
export class AccountApiKeysModule {}
