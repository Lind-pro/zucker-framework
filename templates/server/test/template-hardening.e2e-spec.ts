import { describe, expect, it } from 'vitest';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { AlertController, HealthController, PrometheusExporter, ZuckerMonitoringModule } from '@zucker-framework/monitoring';
import { RATE_LIMIT_KEY } from '@zucker-framework/rate-limiter';
import { nextSubscriptionReconcileAt, SUBSCRIPTION_RECONCILE_PARKED_AT } from '../src/billing/subscription-schedule';
import { assertSecretsFollowEndpoint } from '../src/runtime-settings/connection-settings.service';
import { connectionProfile } from '../src/runtime-settings/connection-settings.descriptors';
import { APP_RATE_LIMITERS, BILLING_WEBHOOK_LIMITER, LOGIN_ACCOUNT_LIMITER, LOGIN_LIMITER, loginAccountKey } from '../src/rate-limits';
import { DEFAULT_OWNER_MAX_BYTES, filesOptionsFromEnvironment } from '../src/files/files.config';
import { PostgresFileAssetRepository } from '../src/files/file-asset.repository';
import { DEFAULT_PRODUCTION_RECORD_LIMIT, quotaOptionsFromEnvironment } from '../src/credits/quota.config';
import { retentionOptionsFromEnvironment } from '../src/maintenance/retention';
import { pageSize } from '../src/content/content.validation';
import { BillingController } from '../src/billing/billing.controller';
import { TRANSACTION_LIMITS } from '../src/database';

describe('subscription reconcile cadence', () => {
  const now = new Date('2026-11-10T00:00:00.000Z'), minutes = (date: Date) => (date.getTime() - now.getTime()) / 60_000;
  const facts = (overrides: Partial<Parameters<typeof nextSubscriptionReconcileAt>[0]>) =>
    ({ status: 'active', cancelState: 'idle', currentPeriodEnd: null, canceledAt: null, ...overrides });
  it('polls unsettled states quickly and stable ones rarely', () => {
    expect(minutes(nextSubscriptionReconcileAt(facts({ status: 'past_due' }), now))).toBe(15);
    expect(minutes(nextSubscriptionReconcileAt(facts({ cancelState: 'submitting' }), now))).toBe(15);
    expect(minutes(nextSubscriptionReconcileAt(facts({}), now))).toBe(360);
    // Renewal evidence appears at period end, sooner than the stable interval.
    expect(minutes(nextSubscriptionReconcileAt(facts({ currentPeriodEnd: new Date(now.getTime() + 60 * 60_000) }), now))).toBe(75);
  });
  it('parks settled cancellations after one follow-up', () => {
    const recent = nextSubscriptionReconcileAt(facts({ status: 'canceled', cancelState: 'confirmed', canceledAt: new Date(now.getTime() - 60 * 60_000) }), now);
    expect(minutes(recent)).toBe(23 * 60);
    expect(nextSubscriptionReconcileAt(facts({ status: 'canceled', canceledAt: new Date('2026-01-01T00:00:00Z') }), now)).toEqual(SUBSCRIPTION_RECONCILE_PARKED_AT);
  });
});

describe('connection endpoint changes', () => {
  const ai = connectionProfile('ai-openai'), smtp = connectionProfile('account-email');
  it('refuses to send a kept or environment secret to a changed endpoint', () => {
    const previous = { AI_OPENAI_API_KEY: 'env-secret' };
    const moved = { ...previous, AI_OPENAI_BASE_URL: 'https://attacker.example/v1' };
    expect(() => assertSecretsFollowEndpoint(ai, previous, moved, {})).toThrow(/re-entering AI_OPENAI_API_KEY/);
    expect(() => assertSecretsFollowEndpoint(ai, previous, moved, { AI_OPENAI_API_KEY: { action: 'keep' } })).toThrow();
    expect(() => assertSecretsFollowEndpoint(ai, previous, { ...moved, AI_OPENAI_API_KEY: 'new' },
      { AI_OPENAI_API_KEY: { action: 'replace', value: 'new' } })).not.toThrow();
    const cleared = { AI_OPENAI_BASE_URL: 'https://attacker.example/v1' };
    expect(() => assertSecretsFollowEndpoint(ai, previous, cleared, { AI_OPENAI_API_KEY: { action: 'clear' } })).not.toThrow();
    expect(() => assertSecretsFollowEndpoint(smtp, { SMTP_HOST: 'a', SMTP_PASSWORD: 'p' }, { SMTP_HOST: 'b', SMTP_PASSWORD: 'p' }, {})).toThrow(/SMTP_PASSWORD/);
  });
  it('allows non-endpoint edits while keeping secrets', () => {
    const previous = { AI_OPENAI_API_KEY: 'secret' };
    expect(() => assertSecretsFollowEndpoint(ai, previous, { ...previous, AI_OPENAI_MODEL_ID: 'x' }, {})).not.toThrow();
  });
});

describe('rate-limit policy', () => {
  it('limits logins per account and gives webhooks their own budget', () => {
    expect(APP_RATE_LIMITERS[LOGIN_LIMITER]).toMatchObject({ points: 5, duration: 900 });
    expect(APP_RATE_LIMITERS[LOGIN_ACCOUNT_LIMITER]?.points).toBeGreaterThan(5);
    expect(loginAccountKey({ username: '  Admin ' })).toBe('admin');
    expect(loginAccountKey({ username: 7 })).toBeUndefined();
    expect(loginAccountKey(null)).toBeUndefined();
    expect(Reflect.getMetadata(RATE_LIMIT_KEY, BillingController.prototype.webhook)).toMatchObject({ limiter: BILLING_WEBHOOK_LIMITER });
    expect(APP_RATE_LIMITERS[BILLING_WEBHOOK_LIMITER]).toBeDefined();
  });
});

describe('resource bounds', () => {
  it('applies per-owner file limits', () => {
    expect(filesOptionsFromEnvironment({})).toMatchObject({ maxOwnerBytes: DEFAULT_OWNER_MAX_BYTES, maxOwnerFiles: 1000 });
    expect(() => filesOptionsFromEnvironment({ FILES_OWNER_MAX_BYTES: '10' })).toThrow();
    const quota = { maxBytes: 100, maxFiles: 2 };
    expect(PostgresFileAssetRepository.exceeds(quota, { bytes: 50, files: 1 }, 50)).toBe(false);
    expect(PostgresFileAssetRepository.exceeds(quota, { bytes: 50, files: 1 }, 51)).toBe(true);
    expect(PostgresFileAssetRepository.exceeds(quota, { bytes: 0, files: 2 }, 1)).toBe(true);
  });
  it('caps demo record jobs by default in production only', () => {
    expect(quotaOptionsFromEnvironment({}).recordLimit).toBeUndefined();
    expect(quotaOptionsFromEnvironment({ NODE_ENV: 'production' }).recordLimit).toBe(DEFAULT_PRODUCTION_RECORD_LIMIT);
    expect(quotaOptionsFromEnvironment({ NODE_ENV: 'production', QUOTA_RECORD_LIMIT: 'off' }).recordLimit).toBeUndefined();
    expect(quotaOptionsFromEnvironment({ QUOTA_RECORD_LIMIT: '7' }).recordLimit).toBe(7);
  });
  it('parses retention windows and content page sizes', () => {
    expect(retentionOptionsFromEnvironment({})).toMatchObject({ apiKeyUsageDays: 90, sessionDays: 30, maintenanceJobDays: 30 });
    expect(retentionOptionsFromEnvironment({ RETENTION_ACCESS_LOG_DAYS: '0' }).accessLogDays).toBe(0);
    expect(() => retentionOptionsFromEnvironment({ RETENTION_SESSION_DAYS: '-1' })).toThrow();
    expect(pageSize(undefined)).toBe(20); expect(pageSize('50')).toBe(50);
    expect(() => pageSize('101')).toThrow(); expect(() => pageSize('0')).toThrow();
    expect(TRANSACTION_LIMITS.timeout).toBeGreaterThan(5000);
  });
});

describe('monitoring routes', () => {
  it('the bare monitoring module the template imports mounts only the public health controller', () => {
    const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ZuckerMonitoringModule) as unknown[];
    expect(controllers).toEqual([HealthController]);
    expect(controllers).not.toContain(AlertController);
    expect(controllers).not.toContain(PrometheusExporter);
  });
});
