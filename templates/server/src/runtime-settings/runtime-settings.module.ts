import { Global, Module } from '@nestjs/common';
import { DATABASE_ADAPTER } from '@zucker-framework/crud';
import { ApplicationDatabase } from '../database';
import { ConnectionSettingsController } from './connection-settings.controller';
import { SiteIntegrationsController } from './site-integrations.controller';
import { ConnectionSettingsService } from './connection-settings.service';
import { RUNTIME_ENVIRONMENT, RUNTIME_SETTINGS_BASE_ENV } from './runtime-settings.tokens';
@Global()
@Module({
  controllers: [ConnectionSettingsController, SiteIntegrationsController],
  providers: [
    { provide: RUNTIME_SETTINGS_BASE_ENV, useFactory: () => Object.freeze({ ...process.env }) },
    { provide: ConnectionSettingsService, inject: [DATABASE_ADAPTER, RUNTIME_SETTINGS_BASE_ENV],
      useFactory: (database: ApplicationDatabase, env: NodeJS.ProcessEnv) => new ConnectionSettingsService(database, env) },
    { provide: RUNTIME_ENVIRONMENT, inject: [ConnectionSettingsService], useFactory: (settings: ConnectionSettingsService) => settings.environment() },
  ],
  // The base environment is exported for other bootstrap readers (e.g. `POLICY_*` pins); never return it over HTTP.
  exports: [ConnectionSettingsService, RUNTIME_ENVIRONMENT, RUNTIME_SETTINGS_BASE_ENV],
})
export class RuntimeSettingsModule {}
