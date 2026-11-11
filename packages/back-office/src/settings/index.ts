// Public surface of `@zucker-framework/back-office/settings` (WP F6): connection settings, hot apply,
// environment pins, data-location guard (D14), product policies and the public site projections.
export { BackOfficeSettingsModule, settingsController } from './settings.module';
export {
  resolveSettingsOptions, connectionServiceOptions,
  type BackOfficeSettingsOptions, type BackOfficeConnectionOptions, type BackOfficePolicyOptions, type ResolvedSettingsOptions, type SettingsFeature,
} from './settings.options';
export {
  SETTINGS_OPTIONS, SETTINGS_BASE_ENVIRONMENT, SETTINGS_RUNTIME_ENVIRONMENT, SETTINGS_CONNECTIONS, SETTINGS_POLICIES, SETTINGS_POLICY_DEFINITIONS,
} from './settings.tokens';
export {
  ConnectionSettingsService, assertSecretsFollowEndpoint, defaultConnectionLabelKeys,
  CONNECTION_SETTINGS_SCOPE, HOT_PROFILE_CACHE_TTL_MS, DEFAULT_SETTINGS_MODELS, DEFAULT_SETTINGS_TABLES,
  type ConnectionSettingsServiceOptions, type ConnectionSaveAuditHook, type ConnectionCredentialSource, type ConnectionLabelKeys,
  type ConnectionLabelKeyResolver, type ConnectionFieldSource, type PublicIntegrationsProjection, type SecretAction,
  type SettingsModelKey, type SettingsTableKey,
} from './connection-settings.service';
export {
  PinnedConnectionProfileStore, resolveConnectionPins, withoutPinnedValues,
  type ConnectionEnvironmentPins, type ResolvedConnectionPins,
} from './connection-pins';
export { toHttpError, withHttpErrors, withHttpErrorsAsync } from './connection-errors';
export {
  HotProvider, hotProviderOf, liveObjectView, liveArrayView, hotConnectionStatus,
  type HotProviderOptions, type HotProviderSettings, type HotConnectionStatus,
} from './hot-apply';
export {
  createDataLocationGuard, DATA_LOCATION_CHANGE_CODE,
  type ConnectionSaveGuard, type ConnectionSaveGuardContext, type ConnectionSaveGuardResult, type DataLocationGuardOptions,
} from './data-location.guard';
export {
  createConnectionSettingsController, createSiteIntegrationsController, createPolicyController, createSiteConfigController,
  SETTINGS_CONTROLLER_KIND, type SettingsControllerKind,
} from './settings.controllers';
export {
  composePolicies, definePolicy, policyEnvironmentKey, policyFieldValue, parsePolicyEnvironmentValue, PolicyValueError,
  type PolicyDefinition, type PolicyField, type PolicyFieldType, type PolicyValue, type PolicyValues,
} from './policy.registry';
export { PolicyService, POLICY_SCOPE, POLICY_CACHE_TTL_MS, type PolicyServiceOptions } from './policy.service';
// Profile declaration helpers, re-exported so a consumer declares profiles against one import.
export {
  composeConnectionProfiles, connectionField, defineConnectionProfile, localizeConnectionDescriptor,
  type ConnectionApplyMode, type ConnectionField, type ConnectionFieldType, type ConnectionProfile, type ConnectionProfileDefinition,
} from '@zucker-framework/config/connections';
