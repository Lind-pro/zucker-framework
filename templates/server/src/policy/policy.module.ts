import { Global, Module, type DynamicModule } from '@nestjs/common';
import { BackOfficeSettingsModule } from '@zucker-framework/back-office/settings';
import { settingsTrustedOrigins } from '../runtime-settings/runtime-settings.module';
import type { PolicyDefinition } from '@zucker-framework/back-office/settings';

export interface PolicyModuleOptions {
  /** Feature policy arrays, e.g. `[...ACCOUNT_POLICIES, ...AI_POLICIES]`; ids must be unique. */
  policies: readonly PolicyDefinition[];
  /** Mount `GET /site/public/config` (default true). */
  publicConfig?: boolean;
}

/**
 * Policy host (`@zucker-framework/back-office/settings`): `management/policies` and `site/public/config`.
 * Global, so any feature can inject `PolicyService`. Requires `RuntimeSettingsModule` (base environment
 * for `POLICY_*` pins) and the CRUD database adapter.
 */
@Global()
@Module({})
export class PolicyModule {
  static forRoot(options: PolicyModuleOptions): DynamicModule {
    return {
      module: PolicyModule,
      imports: [BackOfficeSettingsModule.forRoot({
        trustedOrigins: settingsTrustedOrigins, rateLimit: { limiter: 'api-default' }, guards: [],
        policies: { definitions: options.policies, publicConfig: options.publicConfig },
      })],
    };
  }
}
