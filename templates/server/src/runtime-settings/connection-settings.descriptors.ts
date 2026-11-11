import { BadRequestException } from '@nestjs/common';
import type { ConnectionSettingsServiceOptions } from '@zucker-framework/back-office/settings';
import { AI_CONNECTIONS } from '../ai-connections/ai-connections.config';
import { AI_CONNECTION_PROFILES } from './profiles/ai.profiles';
import { IDENTITY_CONNECTION_PROFILES } from './profiles/identity.profiles';
import { MAIL_CONNECTION_PROFILES } from './profiles/mail.profiles';
import { PAYMENT_CONNECTION_PROFILES } from './profiles/payment.profiles';
import { PUBLIC_SITE_CONNECTION_PROFILES } from './profiles/public-site.profiles';
import { STORAGE_CONNECTION_PROFILES } from './profiles/storage.profiles';
import { composeConnectionProfiles, type ConnectionApplyMode, type ConnectionField, type ConnectionProfile, type ConnectionProfileDefinition } from './registry';
import { publicIntegrationsProjection } from './site-public.config';

export type { ConnectionApplyMode, ConnectionField, ConnectionFieldType, ConnectionProfile, ConnectionProfileDefinition } from './registry';
/**
 * The only composition point for saved connection profiles. A new feature exports an array of
 * `defineConnectionProfile(...)` from its own folder and is appended here (one import, one argument).
 * The order is the admin display order; ids and environment keys must stay unique (checked at load).
 */
export const CONNECTION_PROFILE_DEFINITIONS: readonly ConnectionProfileDefinition[] = composeConnectionProfiles(
  AI_CONNECTION_PROFILES, PUBLIC_SITE_CONNECTION_PROFILES, PAYMENT_CONNECTION_PROFILES, IDENTITY_CONNECTION_PROFILES,
  MAIL_CONNECTION_PROFILES, STORAGE_CONNECTION_PROFILES,
);
export const CONNECTION_PROFILES: readonly ConnectionProfile[] = CONNECTION_PROFILE_DEFINITIONS.map(definition => definition.profile);
const CATEGORY_KEYS: Readonly<Record<string, string>> = { AI: 'ai', '公开站点': 'public-site', '支付': 'payments', '登录': 'sign-in', '邮件': 'mail', '存储': 'storage' };
/**
 * Stable translation keys sent next to the display text (`labelKey` and friends), so clients
 * translate by key instead of by the exact Chinese wording. AI fields share keys across providers.
 */
export function connectionLabelKeys(profile: ConnectionProfile) {
  const prefix = AI_CONNECTIONS.find(connection => connection.id === profile.id)?.prefix;
  const fieldKey = (field: ConnectionField) =>
    `connections.field.${prefix && field.key.startsWith(`${prefix}_`) ? `AI_${field.key.slice(prefix.length + 1)}` : field.key}`;
  return {
    labelKey: `connections.${profile.id}`,
    categoryKey: `connections.category.${CATEGORY_KEYS[profile.category] ?? profile.category.toLowerCase()}`,
    field: (field: ConnectionField) => ({ labelKey: fieldKey(field), ...(field.description ? { descriptionKey: `${fieldKey(field)}.description` } : {}) }),
  };
}
function connectionDefinition(id: string): ConnectionProfileDefinition {
  const definition = CONNECTION_PROFILE_DEFINITIONS.find(row => row.profile.id === id); if (!definition) throw new BadRequestException('Unknown connection profile'); return definition;
}
export function connectionProfile(id: string): ConnectionProfile { return connectionDefinition(id).profile; }
export function connectionApplyMode(id: string): ConnectionApplyMode { return connectionDefinition(id).applyMode; }

/**
 * Settings host configuration of the template (`@zucker-framework/back-office/settings`): profiles, label
 * keys and the public website projection. No field is environment-pinned in the template; a product
 * pins fields with `environmentPins` (read-only in the admin, never written to the database).
 */
export const TEMPLATE_CONNECTION_SETTINGS = Object.freeze({
  profiles: CONNECTION_PROFILE_DEFINITIONS,
  labelKeys: connectionLabelKeys,
  publicIntegrations: publicIntegrationsProjection,
}) satisfies ConnectionSettingsServiceOptions;
