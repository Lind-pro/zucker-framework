import { Module } from '@nestjs/common';
import { AccountModule } from '../accounts/account.module';
import { OAuthController } from './oauth.controller';
import { OAuthService } from './oauth.service';
import { OAUTH_SETTINGS, oauthSettings } from './oauth.config';
import { ConfiguredOAuthProviderClient, OAUTH_PROVIDER_CLIENT } from './oauth-provider';
import { RUNTIME_ENVIRONMENT } from '../runtime-settings/runtime-settings.tokens';

@Module({
  imports: [AccountModule],
  controllers: [OAuthController],
  providers: [OAuthService, { provide: OAUTH_SETTINGS, inject: [{ token: RUNTIME_ENVIRONMENT, optional: true }],
    useFactory: (environment?: Readonly<NodeJS.ProcessEnv>) => oauthSettings(environment ?? process.env) },
    ConfiguredOAuthProviderClient, { provide: OAUTH_PROVIDER_CLIENT, useExisting: ConfiguredOAuthProviderClient }],
  exports: [OAuthService],
})
export class OAuthModule {}
