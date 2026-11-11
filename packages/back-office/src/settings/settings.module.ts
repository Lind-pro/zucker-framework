import { Module, type DynamicModule, type Provider, type Type } from '@nestjs/common';
import type { ConnectionDatabase } from '@zucker-framework/config/connections';
import { ConnectionSettingsService } from './connection-settings.service';
import { PolicyService } from './policy.service';
import {
  createConnectionSettingsController, createPolicyController, createSiteConfigController, createSiteIntegrationsController,
  SETTINGS_CONTROLLER_KIND, type SettingsControllerKind,
} from './settings.controllers';
import { connectionServiceOptions, resolveSettingsOptions, type BackOfficeSettingsOptions } from './settings.options';
import {
  SETTINGS_BASE_ENVIRONMENT, SETTINGS_CONNECTIONS, SETTINGS_OPTIONS, SETTINGS_POLICIES, SETTINGS_POLICY_DEFINITIONS, SETTINGS_RUNTIME_ENVIRONMENT,
} from './settings.tokens';

/**
 * Connection settings (encrypted profiles, revision archive, hot apply, environment pins) and product
 * policies. Needs the consumer's database adapter (`DATABASE_ADAPTER` by default; PostgreSQL with
 * `transaction` and transactional `query`), the `config`, `connection_profile_revisions` and
 * `operation_logs` tables, the consumer's authentication/permission guards and rate limiter.
 *
 * Exports (when the feature is enabled): `SETTINGS_BASE_ENVIRONMENT` (when `environment` is given),
 * `SETTINGS_CONNECTIONS` / `ConnectionSettingsService`, `SETTINGS_RUNTIME_ENVIRONMENT`,
 * `SETTINGS_POLICIES` / `PolicyService`, `SETTINGS_POLICY_DEFINITIONS`, `SETTINGS_OPTIONS`.
 * Global by default. Two instances may be composed (for example connections in one, policies in
 * another); only one may register `environment`.
 */
@Module({})
export class BackOfficeSettingsModule {
  static forRoot(input: BackOfficeSettingsOptions = {}): DynamicModule {
    const options = resolveSettingsOptions(input);
    const providers: Provider[] = [{ provide: SETTINGS_OPTIONS, useValue: options }];
    const exports: Array<symbol | Type<unknown>> = [SETTINGS_OPTIONS];
    const controllers: Type<unknown>[] = [];
    if (options.environment) {
      const read = options.environment;
      providers.push({ provide: SETTINGS_BASE_ENVIRONMENT, useFactory: () => Object.freeze({ ...read() }) });
      exports.push(SETTINGS_BASE_ENVIRONMENT);
    }
    if (options.connections) {
      const serviceOptions = connectionServiceOptions(options);
      providers.push(
        { provide: SETTINGS_CONNECTIONS, inject: [options.database, SETTINGS_BASE_ENVIRONMENT],
          useFactory: (database: ConnectionDatabase, environment: NodeJS.ProcessEnv) => new ConnectionSettingsService(database, environment, serviceOptions) },
        { provide: ConnectionSettingsService, useExisting: SETTINGS_CONNECTIONS },
        { provide: SETTINGS_RUNTIME_ENVIRONMENT, inject: [SETTINGS_CONNECTIONS], useFactory: (settings: ConnectionSettingsService) => settings.environment() },
      );
      exports.push(SETTINGS_CONNECTIONS, ConnectionSettingsService, SETTINGS_RUNTIME_ENVIRONMENT);
      controllers.push(createConnectionSettingsController(options));
      if (options.connections.publicIntegrations) controllers.push(createSiteIntegrationsController(options));
    }
    if (options.policies) {
      const policies = options.policies;
      providers.push(
        { provide: SETTINGS_POLICY_DEFINITIONS, useValue: policies.definitions },
        { provide: SETTINGS_POLICIES, inject: [options.database, SETTINGS_BASE_ENVIRONMENT],
          useFactory: (database: ConnectionDatabase, environment: NodeJS.ProcessEnv) => new PolicyService(database, policies.definitions, environment, {
            cacheTtlMs: policies.cacheTtlMs, scope: policies.scope, operationLogsModel: options.models.operationLogs,
            audit: { module: policies.auditModule, path: `/${options.path}/policies` },
          }) },
        { provide: PolicyService, useExisting: SETTINGS_POLICIES },
      );
      exports.push(SETTINGS_POLICY_DEFINITIONS, SETTINGS_POLICIES, PolicyService);
      controllers.push(createPolicyController(options));
      if (policies.publicConfig) controllers.push(createSiteConfigController(options));
    }
    return { module: BackOfficeSettingsModule, global: options.global, controllers, providers, exports };
  }
}

/** The generated controller class of one route group in a `forRoot` result (for interceptors that match by class). */
export function settingsController(module: DynamicModule, kind: SettingsControllerKind): Type<unknown> | undefined {
  return (module.controllers ?? []).find(controller => (controller as unknown as Record<symbol, unknown>)[SETTINGS_CONTROLLER_KIND] === kind) as Type<unknown> | undefined;
}
