import { beforeEach, describe, expect, it } from 'vitest';
import { FeatureFlagEvaluator, defaultFeatureFlagEnvKey } from './index';

describe('FeatureFlagEvaluator', () => {
  let evaluator: FeatureFlagEvaluator;
  let environment: Record<string, string | undefined>;

  beforeEach(() => {
    environment = {};
    evaluator = new FeatureFlagEvaluator((key) => environment[key]);
  });

  it('uses the legacy normalized FF_ key when no explicit env key is provided', () => {
    environment.FF_TEST_FLAG = 'true';
    evaluator.register({ key: 'test.flag', defaultValue: false });

    expect(defaultFeatureFlagEnvKey('test.flag')).toBe('FF_TEST_FLAG');
    expect(evaluator.evaluate('test.flag')).toEqual({
      key: 'test.flag',
      enabled: true,
      reason: 'environment',
      envKey: 'FF_TEST_FLAG',
    });
  });

  it('supports an explicit deployment env key with fail-closed exact values', () => {
    evaluator.register({
      key: 'durable.example',
      envKey: 'DURABLE_EXAMPLE_ENABLED',
      envEnabledValues: ['true'],
      defaultValue: false,
    });

    environment.DURABLE_EXAMPLE_ENABLED = '1';
    expect(evaluator.isEnabled('durable.example')).toBe(false);

    environment.DURABLE_EXAMPLE_ENABLED = 'TRUE';
    expect(evaluator.isEnabled('durable.example')).toBe(false);

    environment.DURABLE_EXAMPLE_ENABLED = 'true';
    expect(evaluator.isEnabled('durable.example')).toBe(true);
  });

  it('can opt into normalized environment values without changing strict flags', () => {
    evaluator.register({
      key: 'product.flow',
      envKey: 'DURABLE_EXAMPLE_ENABLED',
      envEnabledValues: ['true', '1', 'on'],
      normalizeEnvValue: true,
      defaultValue: false,
    });
    environment.DURABLE_EXAMPLE_ENABLED = ' ON ';

    expect(evaluator.isEnabled('product.flow')).toBe(true);
  });

  it('keeps environment control above runtime overrides', () => {
    evaluator.register({
      key: 'durable.example',
      envKey: 'DURABLE_EXAMPLE_ENABLED',
      defaultValue: false,
    });
    evaluator.setUserOverride('durable.example', 'user-1', true);
    environment.DURABLE_EXAMPLE_ENABLED = 'false';

    expect(evaluator.evaluate('durable.example', { userId: 'user-1' })).toMatchObject({
      enabled: false,
      reason: 'environment',
    });
  });

  it('returns auditable decisions without exposing subject data or raw env values', () => {
    evaluator.register({
      key: 'beta',
      defaultValue: false,
      rules: [{ type: 'percentage', percentage: 50 }],
    });

    const first = evaluator.evaluate('beta', {
      userId: 'private-user-id',
      roles: ['private-role'],
      attributes: { region: 'private-region' },
    });
    const second = evaluator.evaluate('beta', { userId: 'private-user-id' });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      reason: 'rule',
      ruleIndex: 0,
      ruleType: 'percentage',
      bucket: expect.any(Number),
    });
    expect(JSON.stringify(first)).not.toContain('private');
  });

  it('preserves ordered allowlist and percentage rule behavior', () => {
    evaluator.register({
      key: 'mixed',
      defaultValue: false,
      rules: [
        { type: 'allowlist', values: ['vip-user'] },
        { type: 'percentage', percentage: 0 },
      ],
    });

    expect(evaluator.evaluate('mixed', { userId: 'vip-user' })).toMatchObject({
      enabled: true,
      reason: 'rule',
      ruleIndex: 0,
    });
    expect(evaluator.evaluate('mixed', { userId: 'regular-user' })).toMatchObject({
      enabled: false,
      reason: 'rule',
      ruleIndex: 1,
    });
  });

  it('reports disabled, default, and unregistered decisions explicitly', () => {
    evaluator.register({ key: 'disabled', defaultValue: false, enabled: false });
    evaluator.register({ key: 'default-on', defaultValue: true });

    expect(evaluator.evaluate('disabled')).toEqual({
      key: 'disabled',
      enabled: false,
      reason: 'disabled',
    });
    expect(evaluator.evaluate('default-on')).toEqual({
      key: 'default-on',
      enabled: true,
      reason: 'default',
    });
    expect(evaluator.evaluate('unknown')).toEqual({
      key: 'unknown',
      enabled: false,
      reason: 'unregistered',
    });
  });
});
