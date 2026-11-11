import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { AI_CONNECTION_DESCRIPTORS } from '@zucker-framework/ai';
import { OAUTH_CONNECTION_DESCRIPTORS } from '@zucker-framework/auth';
import { MAIL_CONNECTION_DESCRIPTORS } from '@zucker-framework/notification';
import { PAYMENT_CONNECTION_DESCRIPTORS } from '@zucker-framework/payment';
import { PRIVATE_FILES_CONNECTION_DESCRIPTOR } from '@zucker-framework/storage';
import { CONNECTION_PROFILE_DEFINITIONS } from '../src/runtime-settings/connection-settings.descriptors';

/**
 * Saved configuration is keyed by profile id and environment key. A rename silently drops a saved
 * credential, so ids, keys and field types are pinned to the values at the 4.1a extraction (HEAD 7f6b6c5).
 * Changing a line here is a storage migration, not a refactor.
 */
const PINNED = [
  'ai-openai AI_OPENAI_ENABLED:boolean AI_OPENAI_API_KEY:secret AI_OPENAI_MODEL_ID:text AI_OPENAI_BASE_URL:url AI_OPENAI_MAX_TOKENS:number AI_OPENAI_TIMEOUT_MS:number',
  'ai-compatible AI_COMPATIBLE_ENABLED:boolean AI_COMPATIBLE_API_KEY:secret AI_COMPATIBLE_MODEL_ID:text AI_COMPATIBLE_BASE_URL:url AI_COMPATIBLE_MAX_TOKENS:number AI_COMPATIBLE_TIMEOUT_MS:number',
  'ai-openrouter AI_OPENROUTER_ENABLED:boolean AI_OPENROUTER_API_KEY:secret AI_OPENROUTER_MODEL_ID:text AI_OPENROUTER_BASE_URL:url AI_OPENROUTER_MAX_TOKENS:number AI_OPENROUTER_TIMEOUT_MS:number',
  'ai-deepseek AI_DEEPSEEK_ENABLED:boolean AI_DEEPSEEK_API_KEY:secret AI_DEEPSEEK_MODEL_ID:text AI_DEEPSEEK_BASE_URL:url AI_DEEPSEEK_MAX_TOKENS:number AI_DEEPSEEK_TIMEOUT_MS:number',
  'ai-anthropic AI_ANTHROPIC_ENABLED:boolean AI_ANTHROPIC_API_KEY:secret AI_ANTHROPIC_MODEL_ID:text AI_ANTHROPIC_BASE_URL:url AI_ANTHROPIC_MAX_TOKENS:number AI_ANTHROPIC_TIMEOUT_MS:number',
  'ai-gemini AI_GEMINI_ENABLED:boolean AI_GEMINI_API_KEY:secret AI_GEMINI_MODEL_ID:text AI_GEMINI_BASE_URL:url AI_GEMINI_MAX_TOKENS:number AI_GEMINI_TIMEOUT_MS:number',
  'web-analytics SITE_ANALYTICS_ENABLED:boolean GOOGLE_ANALYTICS_ENABLED:boolean GOOGLE_ANALYTICS_MEASUREMENT_ID:text CLARITY_ENABLED:boolean CLARITY_PROJECT_ID:text PLAUSIBLE_ENABLED:boolean PLAUSIBLE_SCRIPT_URL:text OPENPANEL_ENABLED:boolean OPENPANEL_CLIENT_ID:text OPENPANEL_API_URL:text VERCEL_ANALYTICS_ENABLED:boolean VERCEL_ANALYTICS_SCRIPT_PATH:text',
  'web-connections SITE_CONNECTIONS_ENABLED:boolean ADSENSE_ENABLED:boolean ADSENSE_PUBLISHER_ID:text AFFONSO_ENABLED:boolean AFFONSO_PROGRAM_ID:text AFFONSO_COOKIE_DURATION_DAYS:number PROMOTEKIT_ENABLED:boolean PROMOTEKIT_PROGRAM_ID:text CRISP_ENABLED:boolean CRISP_WEBSITE_ID:text TAWK_ENABLED:boolean TAWK_PROPERTY_ID:text TAWK_WIDGET_ID:text',
  'payment-stripe BILLING_STRIPE_ENABLED:boolean BILLING_STRIPE_MODE:select BILLING_STRIPE_ACCOUNT_SCOPE:text STRIPE_SECRET_KEY:secret STRIPE_WEBHOOK_SECRET:secret',
  'payment-paypal BILLING_PAYPAL_ENABLED:boolean BILLING_PAYPAL_MODE:select BILLING_PAYPAL_ACCOUNT_SCOPE:text PAYPAL_CLIENT_ID:text PAYPAL_CLIENT_SECRET:secret PAYPAL_WEBHOOK_ID:text',
  'payment-creem BILLING_CREEM_ENABLED:boolean BILLING_CREEM_MODE:select BILLING_CREEM_ACCOUNT_SCOPE:text CREEM_API_KEY:secret CREEM_WEBHOOK_SECRET:secret',
  'identity-google GOOGLE_OAUTH_ENABLED:boolean GOOGLE_ONE_TAP_ENABLED:boolean GOOGLE_CLIENT_ID:text GOOGLE_CLIENT_SECRET:secret',
  'identity-github GITHUB_OAUTH_ENABLED:boolean GITHUB_CLIENT_ID:text GITHUB_CLIENT_SECRET:secret',
  'account-email MAIL_PROVIDER:select SMTP_FROM:text SMTP_HOST:text SMTP_PORT:number SMTP_SECURE:boolean SMTP_USER:text SMTP_PASSWORD:secret MAIL_RESEND_API_KEY:secret',
  'durable-email DELIVERY_PROVIDER:select DELIVERY_ACCOUNT_SCOPE:text DELIVERY_FROM:text DELIVERY_RESEND_API_KEY:secret DELIVERY_SMTP_HOST:text DELIVERY_SMTP_PORT:number DELIVERY_SMTP_SECURE:boolean DELIVERY_SMTP_USER:text DELIVERY_SMTP_PASSWORD:secret',
  'private-files FILES_STORAGE_PROVIDER:select FILES_S3_BUCKET:text FILES_S3_REGION:text FILES_S3_ENDPOINT:url FILES_S3_ACCESS_KEY_ID:secret FILES_S3_SECRET_ACCESS_KEY:secret FILES_S3_FORCE_PATH_STYLE:boolean',
];
/** sha256 of JSON.stringify(profiles) at extraction: labels, defaults, options and limits are unchanged too. */
const PINNED_PROFILES_SHA256 = 'bb0a7ad078236158c35cbd22a46d65a530db9390a058a452a9c703990dd4caf1';

describe('connection profile ids and keys (storage contract)', () => {
  it('keeps every profile id, environment key and field type', () => {
    expect(CONNECTION_PROFILE_DEFINITIONS.map(({ profile }) => `${profile.id} ${profile.fields.map(field => `${field.key}:${field.type}`).join(' ')}`)).toEqual(PINNED);
  });
  it('keeps the complete profile declarations byte for byte', () => {
    const profiles = JSON.stringify(CONNECTION_PROFILE_DEFINITIONS.map(({ profile }) => profile));
    expect(createHash('sha256').update(profiles).digest('hex')).toBe(PINNED_PROFILES_SHA256);
  });
  it('package descriptors declare exactly the ids, keys and types the template stores', () => {
    const descriptors = [...AI_CONNECTION_DESCRIPTORS, ...OAUTH_CONNECTION_DESCRIPTORS, ...MAIL_CONNECTION_DESCRIPTORS, ...PAYMENT_CONNECTION_DESCRIPTORS, PRIVATE_FILES_CONNECTION_DESCRIPTOR];
    for (const descriptor of descriptors) {
      const profile = CONNECTION_PROFILE_DEFINITIONS.find(row => row.profile.id === descriptor.profile.id)?.profile;
      expect(profile, descriptor.profile.id).toBeDefined();
      expect(descriptor.profile.fields.map(field => [field.key, field.type, field.options ?? null, field.defaultValue ?? null]))
        .toEqual(profile!.fields.map(field => [field.key, field.type, field.options ?? null, field.defaultValue ?? null]));
    }
  });
  it('package descriptors carry only plain data with stable label keys', () => {
    for (const descriptor of [...AI_CONNECTION_DESCRIPTORS, ...PAYMENT_CONNECTION_DESCRIPTORS]) {
      expect(descriptor.profile.labelKey).toBe(`connections.${descriptor.profile.id}`);
      for (const field of descriptor.profile.fields) expect(field.labelKey).toMatch(/^connections\.field\.[A-Z][A-Z0-9_]*$/);
    }
  });
});
