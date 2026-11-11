import { ConnectionSettingsService as SettingsHostService, type ConnectionSettingsServiceOptions } from '@zucker-framework/back-office/settings';
import type { ConnectionDatabase } from '@zucker-framework/config/connections';
import { TEMPLATE_CONNECTION_SETTINGS } from './connection-settings.descriptors';
import type { publicIntegrationsProjection } from './site-public.config';

export {
  assertSecretsFollowEndpoint, CONNECTION_SETTINGS_SCOPE, HOT_PROFILE_CACHE_TTL_MS,
  type ConnectionSaveAuditHook, type SecretAction,
} from '@zucker-framework/back-office/settings';
export { connectionEndpointField } from '@zucker-framework/config/connections';
export interface ConnectionSettingsOptions { hotProfileCacheTtlMs?: number }

/**
 * The template's connection settings: the settings host service bound to the template's profiles and
 * label keys. `RuntimeSettingsModule` registers the host instance under this class too, so features and
 * tests inject or construct it the same way (`new ConnectionSettingsService(database, environment)`).
 */
export class ConnectionSettingsService extends SettingsHostService {
  constructor(database: ConnectionDatabase, environment: NodeJS.ProcessEnv, options: ConnectionSettingsOptions = {}) {
    super(database, environment, { ...TEMPLATE_CONNECTION_SETTINGS, ...options } satisfies ConnectionSettingsServiceOptions);
  }
  /** Typed public website projection (`{analytics, connections, revisions}`) of the template's public profiles. */
  override publicIntegrations(): Promise<ReturnType<typeof publicIntegrationsProjection>> {
    return super.publicIntegrations() as Promise<ReturnType<typeof publicIntegrationsProjection>>;
  }
}
