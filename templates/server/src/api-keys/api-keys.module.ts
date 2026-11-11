import { Global, Module } from '@nestjs/common';
import {
  ACCOUNT_API_KEY_SERVICE_PROVIDER, ACCOUNTS_API_KEY_AUTHENTICATOR, AccountApiKeyAuthenticator, AccountApiKeysController, AccountApiKeysService,
  ApiKeyAccountController,
} from '@zucker-framework/back-office/accounts';
import { AccountModule } from '../accounts/account.module';

/** Self-service API keys (`/authorize/api-keys`, `GET /v1/account`) and key authentication of `@AccountApiKeyScopes` routes. */
@Global()
@Module({
  imports: [AccountModule],
  controllers: [AccountApiKeysController, ApiKeyAccountController],
  providers: [ACCOUNT_API_KEY_SERVICE_PROVIDER, AccountApiKeysService, AccountApiKeyAuthenticator,
    { provide: ACCOUNTS_API_KEY_AUTHENTICATOR, useExisting: AccountApiKeyAuthenticator }],
  exports: [ACCOUNTS_API_KEY_AUTHENTICATOR],
})
export class AccountApiKeysModule {}
