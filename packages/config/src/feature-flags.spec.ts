import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FeatureFlagService } from './feature-flags';

describe('FeatureFlagService', () => {
  let service: FeatureFlagService;

  beforeEach(() => {
    service = new FeatureFlagService();
  });

  afterEach(() => {
    // Clean env overrides
    delete process.env.FF_TEST_FLAG;
    delete process.env.FF_NEW_DASHBOARD;
  });

  describe('basic evaluation', () => {
    it('should return false for unregistered flag', () => {
      expect(service.isEnabled('unknown')).toBe(false);
    });

    it('should return defaultValue when no rules match', () => {
      service.register({ key: 'test', defaultValue: true });
      expect(service.isEnabled('test')).toBe(true);
    });

    it('should return defaultValue when flag is disabled', () => {
      service.register({ key: 'test', defaultValue: false, enabled: false, rules: [{ type: 'percentage', percentage: 100 }] });
      expect(service.isEnabled('test')).toBe(false);
    });
  });

  describe('environment variable override (Layer 1)', () => {
    it('should override with FF_ env var = true', () => {
      process.env.FF_TEST_FLAG = 'true';
      service.register({ key: 'test_flag', defaultValue: false });
      expect(service.isEnabled('test_flag')).toBe(true);
    });

    it('should override with FF_ env var = false', () => {
      process.env.FF_NEW_DASHBOARD = 'false';
      service.register({ key: 'new_dashboard', defaultValue: true });
      expect(service.isEnabled('new_dashboard')).toBe(false);
    });

    it('should accept "1" as true', () => {
      process.env.FF_TEST_FLAG = '1';
      service.register({ key: 'test_flag', defaultValue: false });
      expect(service.isEnabled('test_flag')).toBe(true);
    });
  });

  describe('user/tenant override (Layer 2)', () => {
    it('should respect user override', () => {
      service.register({ key: 'beta', defaultValue: false });
      service.setUserOverride('beta', 'user-1', true);

      expect(service.isEnabled('beta', { userId: 'user-1' })).toBe(true);
      expect(service.isEnabled('beta', { userId: 'user-2' })).toBe(false);
    });

    it('should respect tenant override', () => {
      service.register({ key: 'beta', defaultValue: false });
      service.setTenantOverride('beta', 'tenant-vip', true);

      expect(service.isEnabled('beta', { tenantId: 'tenant-vip' })).toBe(true);
      expect(service.isEnabled('beta', { tenantId: 'tenant-normal' })).toBe(false);
    });

    it('should clear override', () => {
      service.register({ key: 'beta', defaultValue: false });
      service.setUserOverride('beta', 'u1', true);
      expect(service.isEnabled('beta', { userId: 'u1' })).toBe(true);

      service.clearOverride('beta', 'user:u1');
      expect(service.isEnabled('beta', { userId: 'u1' })).toBe(false);
    });
  });

  describe('percentage rule (Layer 3)', () => {
    it('should return true for 100%', () => {
      service.register({ key: 'full', defaultValue: false, rules: [{ type: 'percentage', percentage: 100 }] });
      expect(service.isEnabled('full', { userId: 'anyone' })).toBe(true);
    });

    it('should return false for 0%', () => {
      service.register({ key: 'none', defaultValue: false, rules: [{ type: 'percentage', percentage: 0 }] });
      expect(service.isEnabled('none', { userId: 'anyone' })).toBe(false);
    });

    it('should be deterministic for same user+flag', () => {
      service.register({ key: 'half', defaultValue: false, rules: [{ type: 'percentage', percentage: 50 }] });

      const result1 = service.isEnabled('half', { userId: 'user-42' });
      const result2 = service.isEnabled('half', { userId: 'user-42' });
      expect(result1).toBe(result2); // Same user, same result
    });

    it('should distribute across users', () => {
      service.register({ key: 'half', defaultValue: false, rules: [{ type: 'percentage', percentage: 50 }] });

      let enabled = 0;
      for (let i = 0; i < 100; i++) {
        if (service.isEnabled('half', { userId: `user-${i}` })) enabled++;
      }
      // Should be roughly 50% (allow wide range for small sample)
      expect(enabled).toBeGreaterThan(20);
      expect(enabled).toBeLessThan(80);
    });
  });

  describe('allowlist rule', () => {
    it('should enable for users in allowlist', () => {
      service.register({
        key: 'beta',
        defaultValue: false,
        rules: [{ type: 'allowlist', values: ['user-vip', 'tenant-premium'] }],
      });

      expect(service.isEnabled('beta', { userId: 'user-vip' })).toBe(true);
      expect(service.isEnabled('beta', { tenantId: 'tenant-premium' })).toBe(true);
      expect(service.isEnabled('beta', { userId: 'user-normal' })).toBe(false);
    });

    it('should match roles', () => {
      service.register({
        key: 'admin_feature',
        defaultValue: false,
        rules: [{ type: 'allowlist', values: ['admin', 'superadmin'] }],
      });

      expect(service.isEnabled('admin_feature', { roles: ['admin'] })).toBe(true);
      expect(service.isEnabled('admin_feature', { roles: ['user'] })).toBe(false);
    });
  });

  describe('blocklist rule', () => {
    it('should disable for users in blocklist', () => {
      service.register({
        key: 'feature',
        defaultValue: true,
        rules: [{ type: 'blocklist', values: ['banned-user'] }],
      });

      expect(service.isEnabled('feature', { userId: 'banned-user' })).toBe(false);
      expect(service.isEnabled('feature', { userId: 'normal-user' })).toBe(true);
    });
  });

  describe('attribute rule', () => {
    it('should match attribute eq', () => {
      service.register({
        key: 'cn_only',
        defaultValue: false,
        rules: [{ type: 'attribute', attribute: { key: 'region', operator: 'eq', value: 'CN' } }],
      });

      expect(service.isEnabled('cn_only', { attributes: { region: 'CN' } })).toBe(true);
      expect(service.isEnabled('cn_only', { attributes: { region: 'US' } })).toBe(false);
    });
  });

  describe('rule priority', () => {
    it('should evaluate rules in order, first match wins', () => {
      service.register({
        key: 'mixed',
        defaultValue: false,
        rules: [
          { type: 'allowlist', values: ['vip-user'] },  // First: VIP always on
          { type: 'percentage', percentage: 0 },          // Second: 0% for everyone else
        ],
      });

      expect(service.isEnabled('mixed', { userId: 'vip-user' })).toBe(true);
      expect(service.isEnabled('mixed', { userId: 'normal-user' })).toBe(false);
    });
  });

  describe('getAllFlags', () => {
    it('should return all registered flags', () => {
      service.register({ key: 'a', defaultValue: true });
      service.register({ key: 'b', defaultValue: false });
      expect(service.getAllFlags()).toHaveLength(2);
    });
  });
});
