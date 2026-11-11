import { Global, Module } from '@nestjs/common';
import { BackOfficeSettingsModule, SETTINGS_CONNECTIONS } from '@zucker-framework/back-office/settings';
import { TEMPLATE_CONNECTION_SETTINGS } from './connection-settings.descriptors';
import { ConnectionSettingsService } from './connection-settings.service';

/** Browser origins allowed to save connection profiles and policies (exact `Origin` match). */
export const settingsTrustedOrigins = (): string[] => (process.env.ACCOUNT_ORIGINS ?? 'http://localhost:4201,http://localhost:4202').split(',');

/**
 * Connection settings host (`@zucker-framework/back-office/settings`) with the template's profiles:
 * `management/connection-settings` and `site/public/integrations`. Authentication and permission guards
 * are global in the template; the routes keep the `api-default` rate limiter keyed by user.
 */
export const RUNTIME_SETTINGS_HOST = BackOfficeSettingsModule.forRoot({
  environment: () => ({ ...process.env }),
  trustedOrigins: settingsTrustedOrigins, rateLimit: { limiter: 'api-default' }, guards: [],
  connections: TEMPLATE_CONNECTION_SETTINGS,
});

/**
 * Exports `ConnectionSettingsService`, `RUNTIME_ENVIRONMENT` and `RUNTIME_SETTINGS_BASE_ENV` (globally,
 * through the settings host). The base environment is also read by other bootstrap readers (e.g.
 * `POLICY_*` pins); never return it over HTTP.
 */
@Global()
@Module({
  imports: [RUNTIME_SETTINGS_HOST],
  providers: [{ provide: ConnectionSettingsService, useExisting: SETTINGS_CONNECTIONS }],
  exports: [ConnectionSettingsService],
})
export class RuntimeSettingsModule {}
