import { backOfficeToken } from '../shared/tokens';

/** Resolved `BackOfficeSettingsOptions` (frozen). */
export const SETTINGS_OPTIONS = backOfficeToken('settings', 'options');
/**
 * Bootstrap environment the consumer supplies (`environment` option, or its own provider for this token).
 * Copied and frozen by the services. Never return it, or anything derived from it, over HTTP.
 */
export const SETTINGS_BASE_ENVIRONMENT = backOfficeToken('settings', 'baseEnvironment');
/**
 * Start-up snapshot: base environment plus every saved connection profile (pinned fields always from the
 * base environment). `restart` providers read it once; never return it over HTTP.
 */
export const SETTINGS_RUNTIME_ENVIRONMENT = backOfficeToken('settings', 'runtimeEnvironment');
/** The `ConnectionSettingsService` instance (also registered under its class). */
export const SETTINGS_CONNECTIONS = backOfficeToken('settings', 'connections');
/** The `PolicyService` instance (also registered under its class). */
export const SETTINGS_POLICIES = backOfficeToken('settings', 'policies');
/** Composed `PolicyDefinition[]`. */
export const SETTINGS_POLICY_DEFINITIONS = backOfficeToken('settings', 'policyDefinitions');
