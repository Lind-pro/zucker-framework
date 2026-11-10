import { Global, Module, type DynamicModule } from '@nestjs/common';
import { DATABASE_ADAPTER } from '@zucker-framework/crud';
import { ApplicationDatabase } from '../database';
import { RUNTIME_SETTINGS_BASE_ENV } from '../runtime-settings/runtime-settings.tokens';
import { PolicyController } from './policy.controller';
import { composePolicies, type PolicyDefinition } from './policy.registry';
import { PolicyService } from './policy.service';
import { SiteConfigController } from './site-config.controller';
import { POLICY_DEFINITIONS } from './policy.tokens';

export interface PolicyModuleOptions {
  /** Feature policy arrays, e.g. `[...ACCOUNT_POLICIES, ...AI_POLICIES]`; ids must be unique. */
  policies: readonly PolicyDefinition[];
  /** Mount `GET /site/public/config` (default true). */
  publicConfig?: boolean;
}

/**
 * Global so any feature can inject `PolicyService`. Requires `RuntimeSettingsModule` (base environment
 * for `POLICY_*` pins) and the CRUD database adapter.
 */
@Global()
@Module({})
export class PolicyModule {
  static forRoot(options: PolicyModuleOptions): DynamicModule {
    const policies = composePolicies(options.policies);
    return {
      module: PolicyModule,
      controllers: options.publicConfig === false ? [PolicyController] : [PolicyController, SiteConfigController],
      providers: [
        { provide: POLICY_DEFINITIONS, useValue: policies },
        { provide: PolicyService, inject: [DATABASE_ADAPTER, POLICY_DEFINITIONS, RUNTIME_SETTINGS_BASE_ENV],
          useFactory: (database: ApplicationDatabase, definitions: readonly PolicyDefinition[], env: NodeJS.ProcessEnv) => new PolicyService(database, definitions, env) },
      ],
      exports: [PolicyService, POLICY_DEFINITIONS],
    };
  }
}
