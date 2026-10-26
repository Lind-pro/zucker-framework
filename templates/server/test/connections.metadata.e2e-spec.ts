import { describe, expect, it, vi } from 'vitest';
import { ConnectionsService, connectionSdkAvailable } from '../src/management/connections.service';

describe('management connection metadata', () => {
  it('reports missing/disabled/invalid configuration without returning supplied credential values or performing requests', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('External requests are forbidden in this check');
    });
    try {
      const env = {
        WEB_URL: 'http://localhost:4202',
        BILLING_STRIPE_ENABLED: 'true',
        BILLING_STRIPE_MODE: 'test',
        STRIPE_SECRET_KEY: 'SECRET-STRIPE-SENTINEL',
        GOOGLE_OAUTH_ENABLED: 'true',
        GOOGLE_CLIENT_ID: 'SECRET-GOOGLE-SENTINEL',
        FILES_STORAGE_PROVIDER: 'local',
      };
      const result = await new ConnectionsService(env).inspect();
      expect(result.connections.find((row) => row.id === 'payment-stripe')).toMatchObject({
        status: 'missing',
        missing: ['BILLING_STRIPE_ACCOUNT_SCOPE', 'STRIPE_WEBHOOK_SECRET'],
        source: 'server-environment',
      });
      expect(result.connections.find((row) => row.id === 'payment-paypal')).toMatchObject({
        status: 'disabled',
      });
      expect(result.connections.find((row) => row.id === 'identity-google')).toMatchObject({
        status: 'missing',
        missing: ['GOOGLE_CLIENT_SECRET'],
      });
      expect(result.connections.find((row) => row.id === 'private-files')).toMatchObject({
        status: 'configured',
        mode: 'local',
      });
      expect(result.connections.find((row) => row.id === 'web-connections')).toMatchObject({
        status: 'disabled',
        enabled: false,
        source: 'server-environment',
      });
      expect(JSON.stringify(result)).not.toMatch(/SECRET-STRIPE-SENTINEL|SECRET-GOOGLE-SENTINEL/);
      expect(network).not.toHaveBeenCalled();
      const invalid = await new ConnectionsService({
        NODE_ENV: 'production',
        FILES_STORAGE_PROVIDER: 'local',
        DELIVERY_PROVIDER: 'unknown',
      }).inspect();
      expect(invalid.connections.find((row) => row.id === 'private-files')?.status).toBe('invalid');
      expect(invalid.connections.find((row) => row.id === 'durable-email')?.status).toBe('invalid');
    } finally {
      network.mockRestore();
    }
  });
  it('uses configured parsers and actual local SDK availability while keeping account scopes, keys and mail addresses private', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('No external request');
    });
    try {
      const result = await new ConnectionsService({
        WEB_URL: 'http://localhost:4202',
        BILLING_STRIPE_ENABLED: 'true',
        BILLING_STRIPE_MODE: 'test',
        BILLING_STRIPE_ACCOUNT_SCOPE: 'PRIVATE-MERCHANT',
        STRIPE_SECRET_KEY: 'sk_test_SYNTHETIC',
        STRIPE_WEBHOOK_SECRET: 'whsec_SYNTHETIC',
        BILLING_CATALOG_JSON: '[]',
        DELIVERY_PROVIDER: 'resend',
        DELIVERY_ACCOUNT_SCOPE: 'PRIVATE-MAIL-ACCOUNT',
        DELIVERY_FROM: 'private@example.invalid',
        DELIVERY_RESEND_API_KEY: 're_SYNTHETIC',
        FILES_STORAGE_PROVIDER: 'local',
        GOOGLE_ONE_TAP_ENABLED: 'true',
        GOOGLE_CLIENT_ID: 'synthetic-client',
        SITE_ANALYTICS_ENABLED: 'true',
        GOOGLE_ANALYTICS_ENABLED: 'true',
        GOOGLE_ANALYTICS_MEASUREMENT_ID: 'G-SYNTHETIC123',
        SITE_CONNECTIONS_ENABLED: 'true',
        CRISP_ENABLED: 'true',
        CRISP_WEBSITE_ID: '00000000-0000-4000-8000-000000000001',
      }).inspect();
      expect(result.connections.find((row) => row.id === 'payment-stripe')?.status).toBe(
        connectionSdkAvailable('@zucker-framework/payment', 'stripe')
          ? 'configured'
          : 'missing-sdk',
      );
      expect(result.connections.find((row) => row.id === 'durable-email')?.status).toBe(
        connectionSdkAvailable('@zucker-framework/notification', 'resend')
          ? 'configured'
          : 'missing-sdk',
      );
      expect(result.connections.find((row) => row.id === 'identity-google')?.status).toBe(
        'configured',
      );
      expect(result.connections.find((row) => row.id === 'web-analytics')?.status).toBe(
        'configured',
      );
      expect(result.connections.find((row) => row.id === 'web-connections')?.status).toBe(
        'configured',
      );
      expect(JSON.stringify(result)).not.toMatch(
        /PRIVATE-|sk_test_|whsec_|re_SYNTHETIC|private@example|synthetic-client|G-SYNTHETIC123|00000000-0000-4000-8000-000000000001/,
      );
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  });
});
