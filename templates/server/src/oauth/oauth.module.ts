import { Inject, Module, RequestMethod, type MiddlewareConsumer, type NestModule, type OnModuleDestroy } from '@nestjs/common';
import { AccountModule } from '../accounts/account.module';
import { ConnectionSettingsService } from '../runtime-settings/connection-settings.service';
import { HotProvider, liveObjectView } from '../runtime-settings/hot-apply';
import { RUNTIME_ENVIRONMENT } from '../runtime-settings/runtime-settings.tokens';
import { OAuthController } from './oauth.controller';
import { OAuthService } from './oauth.service';
import { OAUTH_CONNECTION, OAUTH_CONNECTION_PROFILES, OAUTH_SETTINGS, oauthSettings, type OAuthConnection, type OAuthSettings } from './oauth.config';
import { ConfiguredOAuthProviderClient, OAUTH_PROVIDER_CLIENT, type OAuthProviderClient } from './oauth-provider';

/**
 * Sign-in providers follow the hot `identity-google` / `identity-github` profiles. Each request under
 * `/authorize/oauth` is pinned to one revision (`OAUTH_SETTINGS` reads it), and a code exchange or
 * One Tap verification leases the client of the revision it started with. A sign-in started before a
 * client change and completed after it is exchanged with the new client and fails at the provider;
 * the intent then expires as usual. The previous secret is never kept for it.
 */
@Module({
  imports: [AccountModule],
  controllers: [OAuthController],
  providers: [OAuthService,
    { provide: OAUTH_CONNECTION, inject: [{ token: ConnectionSettingsService, optional: true }, { token: RUNTIME_ENVIRONMENT, optional: true }],
      useFactory: (settings?: ConnectionSettingsService, environment?: Readonly<NodeJS.ProcessEnv>) => HotProvider.create(settings, environment, {
        name: 'OAuth sign-in', profiles: OAUTH_CONNECTION_PROFILES,
        build: env => {
          const current = Object.freeze(oauthSettings(env as NodeJS.ProcessEnv));
          return { settings: current, client: new ConfiguredOAuthProviderClient(current) };
        },
      }).ready() },
    { provide: OAUTH_SETTINGS, inject: [OAUTH_CONNECTION], useFactory: (oauth: OAuthConnection): OAuthSettings => liveObjectView(() => oauth.now().settings) },
    { provide: OAUTH_PROVIDER_CLIENT, inject: [OAUTH_CONNECTION], useFactory: (oauth: OAuthConnection): OAuthProviderClient => ({
      code: (provider, input) => oauth.use(current => current.client.code(provider, input)),
      oneTap: (credential, nonce) => oauth.use(current => current.client.oneTap(credential, nonce)),
    }) }],
  exports: [OAuthService],
})
export class OAuthModule implements NestModule, OnModuleDestroy {
  constructor(@Inject(OAUTH_CONNECTION) private readonly oauth: OAuthConnection) {}
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(this.oauth.middleware()).forRoutes({ path: 'authorize/oauth{/*splat}', method: RequestMethod.ALL });
  }
  async onModuleDestroy(): Promise<void> { await this.oauth.close(); }
}
