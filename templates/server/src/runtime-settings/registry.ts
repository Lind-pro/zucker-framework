/**
 * Connection profile registry. The implementation lives in `@zucker-framework/config/connections`;
 * this module keeps the template's existing import path for features (`mail/mail.profiles.ts`, tests).
 * A feature declares its saved connection profile next to its own code with `defineConnectionProfile`
 * and exports it; `connection-settings.descriptors.ts` only composes the exported arrays.
 */
export {
  composeConnectionProfiles, connectionField, defineConnectionProfile, localizeConnectionDescriptor,
  type ConnectionApplyMode, type ConnectionField, type ConnectionFieldType, type ConnectionProfile, type ConnectionProfileDefinition,
} from '@zucker-framework/config/connections';
