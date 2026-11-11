import { describe, expect, it } from 'vitest';
import { PolicyService } from '@zucker-framework/back-office/settings';
import { composePolicies, definePolicy, parsePolicyEnvironmentValue, policyEnvironmentKey, policyFieldValue, PolicyValueError,
  type PolicyField, type PolicyDefinition } from '@zucker-framework/back-office/settings';
import { PolicyModule } from '../src/policy/policy.module';
import { composeRateLimiters } from '../src/rate-limits';
import { composeConnectionProfiles, defineConnectionProfile } from '../src/runtime-settings/registry';
import type { ApplicationDatabase } from '../src/database';

/** Database-free contracts of the policy registry, environment pins and the composition helpers (WP 0.1). */
const ok = { id: 'unit', fields: [{ key: 'flag', type: 'boolean' as const, default: true }] };
const profile = (id: string, keys: string[]) => defineConnectionProfile({ applyMode: 'restart',
  profile: { id, name: id, category: 'test', fields: keys.map(key => ({ key, label: key, type: 'text' as const })) } });

describe('definePolicy', () => {
  it('accepts a valid declaration and freezes it', () => {
    const policy = definePolicy(ok);
    expect(Object.isFrozen(policy)).toBe(true); expect(Object.isFrozen(policy.fields)).toBe(true); expect(Object.isFrozen(policy.fields[0])).toBe(true);
  });
  it.each([
    ['uppercase id', { ...ok, id: 'Bad' }], ['underscore id', { ...ok, id: 'a_b' }], ['empty id', { ...ok, id: '' }], ['leading digit id', { ...ok, id: '1a' }],
    ['no fields', { ...ok, fields: [] }],
    ['snake key', { ...ok, fields: [{ key: 'bad_key', type: 'boolean' as const, default: true }] }],
    ['uppercase-first key', { ...ok, fields: [{ key: 'Bad', type: 'boolean' as const, default: true }] }],
    ['duplicate key', { ...ok, fields: [{ key: 'a', type: 'boolean' as const, default: true }, { key: 'a', type: 'boolean' as const, default: false }] }],
    ['secret type', { ...ok, fields: [{ key: 'token', type: 'secret' as never, default: 'x' }] }],
    ['unknown type', { ...ok, fields: [{ key: 'token', type: 'password' as never, default: 'x' }] }],
    ['wrong default type', { ...ok, fields: [{ key: 'n', type: 'number' as const, default: 'x' as never }] }],
    ['default below min', { ...ok, fields: [{ key: 'n', type: 'number' as const, default: 0, min: 1 }] }],
    ['default above max', { ...ok, fields: [{ key: 'n', type: 'number' as const, default: 11, max: 10 }] }],
    ['non-integer default', { ...ok, fields: [{ key: 'n', type: 'number' as const, default: 1.5, integer: true }] }],
    ['NaN default', { ...ok, fields: [{ key: 'n', type: 'number' as const, default: Number.NaN }] }],
    ['min > max', { ...ok, fields: [{ key: 'n', type: 'number' as const, default: 5, min: 9, max: 2 }] }],
    ['select without options', { ...ok, fields: [{ key: 's', type: 'select' as const, default: 'a' }] }],
    ['select duplicate options', { ...ok, fields: [{ key: 's', type: 'select' as const, default: 'a', options: ['a', 'a'] }] }],
    ['select default not an option', { ...ok, fields: [{ key: 's', type: 'select' as const, default: 'c', options: ['a', 'b'] }] }],
    ['control character in text default', { ...ok, fields: [{ key: 't', type: 'text' as const, default: 'a\u0000b' }] }],
    ['text default longer than max', { ...ok, fields: [{ key: 't', type: 'text' as const, default: 'abcd', max: 3 }] }],
    ['json default undefined', { ...ok, fields: [{ key: 'j', type: 'json' as const, default: undefined as never }] }],
    ['validate rejecting the defaults', { ...ok, validate() { throw new Error('nope'); } }],
  ])('rejects %s', (_name, definition) => { expect(() => definePolicy(definition as PolicyDefinition)).toThrow(); });
  it('does not echo a rejected default value in the error', () => {
    try { definePolicy({ ...ok, fields: [{ key: 'n', type: 'number', default: 'SENTINEL-DEFAULT' as never }] }); expect.unreachable(); }
    catch (error) { expect(String((error as Error).message)).not.toContain('SENTINEL-DEFAULT'); }
  });
});

describe('policy field values', () => {
  const field = (extra: Partial<PolicyField> & Pick<PolicyField, 'type'>): PolicyField => ({ key: 'k', default: null, ...extra } as PolicyField);
  it('validates by type', () => {
    expect(policyFieldValue(field({ type: 'boolean' }), false)).toBe(false);
    for (const bad of ['true', 1, null, undefined]) expect(() => policyFieldValue(field({ type: 'boolean' }), bad)).toThrow(PolicyValueError);
    expect(policyFieldValue(field({ type: 'number', min: 0, max: 5, integer: true }), 5)).toBe(5);
    for (const bad of [6, -1, 1.5, Infinity, Number.NaN, '3']) expect(() => policyFieldValue(field({ type: 'number', min: 0, max: 5, integer: true }), bad)).toThrow(PolicyValueError);
    expect(policyFieldValue(field({ type: 'text', max: 3 }), 'a\nb')).toBe('a\nb');
    for (const bad of ['abcd', 'a\u0007', 5]) expect(() => policyFieldValue(field({ type: 'text', max: 3 }), bad)).toThrow(PolicyValueError);
    expect(() => policyFieldValue(field({ type: 'text', min: 2 }), 'a')).toThrow(PolicyValueError);
    expect(() => policyFieldValue(field({ type: 'text' }), 'x'.repeat(4097))).toThrow(PolicyValueError);
    expect(policyFieldValue(field({ type: 'select', options: ['a', 'b'] }), 'b')).toBe('b');
    expect(() => policyFieldValue(field({ type: 'select', options: ['a', 'b'] }), 'c')).toThrow(PolicyValueError);
  });
  it('json: copies, rejects non-JSON and oversize values, names only the key', () => {
    const json = field({ type: 'json' }), input = { a: [1, { b: 'c' }] };
    const copy = policyFieldValue(json, input); expect(copy).toEqual(input); expect(copy).not.toBe(input);
    expect(() => policyFieldValue(json, undefined)).toThrow(PolicyValueError);
    expect(() => policyFieldValue(json, 'x'.repeat(17 * 1024))).toThrow(PolicyValueError);
    const circular: Record<string, unknown> = {}; circular.self = circular; expect(() => policyFieldValue(json, circular)).toThrow(PolicyValueError);
    expect(() => policyFieldValue(json, () => 1)).toThrow(PolicyValueError);
    try { policyFieldValue(field({ key: 'limit', type: 'number' }), 'SENTINEL-VALUE'); } catch (error) { expect((error as Error).message).toBe('Invalid value for limit'); }
  });
});

describe('policy json NaN', () => {
  // JSON.stringify alone would turn NaN/±Infinity into null; policyFieldValue rejects them at any depth.
  it('rejects NaN instead of silently storing null', () => {
    expect(() => policyFieldValue({ key: 'k', type: 'json', default: null }, { a: Number.NaN })).toThrow(PolicyValueError);
    for (const bad of [Infinity, [1, -Infinity], { a: { b: [Number.NaN] } }])
      expect(() => policyFieldValue({ key: 'k', type: 'json', default: null }, bad)).toThrow(PolicyValueError);
  });
});

describe('environment pins', () => {
  it('derives POLICY_<ID>_<KEY>', () => {
    expect(policyEnvironmentKey('account', 'requireEmailVerification')).toBe('POLICY_ACCOUNT_REQUIRE_EMAIL_VERIFICATION');
    expect(policyEnvironmentKey('ai-limits', 'maxTokens2')).toBe('POLICY_AI_LIMITS_MAX_TOKENS2');
  });
  it('parses strings into the field type', () => {
    expect(parsePolicyEnvironmentValue({ key: 'a', type: 'boolean', default: true }, ' false ')).toBe(false);
    expect(parsePolicyEnvironmentValue({ key: 'a', type: 'number', default: 1 }, '2.5')).toBe(2.5);
    expect(parsePolicyEnvironmentValue({ key: 'a', type: 'json', default: null }, '{"x":[1]}')).toEqual({ x: [1] });
    expect(parsePolicyEnvironmentValue({ key: 'a', type: 'select', default: 'a', options: ['a', 'b'] }, 'b')).toBe('b');
    for (const [type, raw] of [['boolean', 'yes'], ['boolean', '1'], ['number', 'abc'], ['number', '1e3'], ['json', '{bad'], ['select', 'z']] as const)
      expect(() => parsePolicyEnvironmentValue({ key: 'a', type, default: null, options: ['a', 'b'] } as PolicyField, raw)).toThrow(PolicyValueError);
    expect(() => parsePolicyEnvironmentValue({ key: 'a', type: 'number', default: 1, max: 3 }, '4')).toThrow(PolicyValueError);
  });
  const stub = {} as ApplicationDatabase;
  const pinned = definePolicy({ id: 'pins', fields: [{ key: 'limit', type: 'number', default: 1, integer: true, max: 5 }] });
  it('an invalid pin fails construction (startup) without echoing the value', () => {
    expect(() => new PolicyService(stub, [pinned], { POLICY_PINS_LIMIT: 'SENTINEL-PIN' })).toThrow('POLICY_PINS_LIMIT');
    try { new PolicyService(stub, [pinned], { POLICY_PINS_LIMIT: 'SENTINEL-PIN' }); } catch (error) { expect((error as Error).message).not.toContain('SENTINEL-PIN'); }
    expect(() => new PolicyService(stub, [pinned], { POLICY_PINS_LIMIT: '9' })).toThrow();
    expect(() => new PolicyService(stub, [pinned], { POLICY_PINS_LIMIT: '3' })).not.toThrow();
    expect(() => new PolicyService(stub, [pinned], { POLICY_PINS_LIMIT: '' })).not.toThrow();
  });
  it('rejects duplicate policy ids at service construction', () => { expect(() => new PolicyService(stub, [pinned, pinned], {})).toThrow('Duplicate policy pins'); });
});

describe('compose helpers', () => {
  it('composePolicies concatenates and throws on a duplicate id', () => {
    const a = definePolicy(ok), b = definePolicy({ ...ok, id: 'other' });
    expect(composePolicies([a], [b]).map(policy => policy.id)).toEqual(['unit', 'other']);
    expect(() => composePolicies([a], [a])).toThrow('Duplicate policy unit');
    expect(() => PolicyModule.forRoot({ policies: [a, a] })).toThrow('Duplicate policy unit');
  });
  it('composeRateLimiters merges, freezes, copies, and throws on duplicates and bad budgets', () => {
    const one = { alpha: { points: 1, duration: 1 } }, merged = composeRateLimiters(one, { beta: { points: 2, duration: 3 } });
    expect(Object.keys(merged)).toEqual(['alpha', 'beta']); expect(Object.isFrozen(merged)).toBe(true); expect(merged.alpha).not.toBe(one.alpha);
    expect(() => composeRateLimiters(one, { alpha: { points: 9, duration: 9 } })).toThrow('alpha');
    expect(() => composeRateLimiters({ Bad: { points: 1, duration: 1 } })).toThrow('Invalid rate limiter name');
    expect(() => composeRateLimiters({ ok: { points: 0, duration: 1 } })).toThrow();
    expect(() => composeRateLimiters({ ok: { points: 1.5, duration: 1 } })).toThrow();
    expect(() => composeRateLimiters({ ok: { points: 1, duration: 0 } })).toThrow();
    expect(() => composeRateLimiters({ __proto__x: { points: 1, duration: 1 } })).toThrow();
    expect(composeRateLimiters()).toEqual({});
  });
  it('composeConnectionProfiles throws on duplicate profile ids and shared environment keys', () => {
    const a = profile('alpha', ['A_KEY']), b = profile('beta', ['B_KEY']);
    expect(composeConnectionProfiles([a], [b]).map(row => row.profile.id)).toEqual(['alpha', 'beta']);
    expect(() => composeConnectionProfiles([a], [profile('alpha', ['C_KEY'])])).toThrow('Duplicate connection profile alpha');
    expect(() => composeConnectionProfiles([a], [profile('gamma', ['A_KEY'])])).toThrow('A_KEY');
    expect(() => composeConnectionProfiles([a, b], [a])).toThrow();
  });
  it('defineConnectionProfile rejects malformed declarations', () => {
    const base = { applyMode: 'hot' as const, profile: { id: 'p', name: 'p', category: 'c', fields: [{ key: 'P_KEY', label: 'l', type: 'text' as const }] } };
    expect(defineConnectionProfile(base).applyMode).toBe('hot');
    expect(() => defineConnectionProfile({ ...base, applyMode: 'later' as never })).toThrow();
    expect(() => defineConnectionProfile({ ...base, profile: { ...base.profile, id: 'Bad_Id' } })).toThrow();
    expect(() => defineConnectionProfile({ ...base, profile: { ...base.profile, fields: [] } })).toThrow();
    expect(() => defineConnectionProfile({ ...base, profile: { ...base.profile, fields: [{ key: 'lower', label: 'l', type: 'text' }] } })).toThrow();
    expect(() => defineConnectionProfile({ ...base, profile: { ...base.profile, fields: [{ key: 'S', label: 'l', type: 'select' }] } })).toThrow();
    expect(() => defineConnectionProfile({ ...base, profile: { ...base.profile, fields: [{ key: 'S', label: 'l', type: 'weird' as never }] } })).toThrow();
  });
});
