import { describe, it, expect } from 'vitest';
import {
  UsernameValidator,
  DEFAULT_USERNAME_POLICY,
} from './username-validator';

describe('UsernameValidator', () => {
  const validator = new UsernameValidator();

  it('should accept a valid username', () => {
    const result = validator.validate('john_doe');
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should reject an empty username', () => {
    const result = validator.validate('');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Username cannot be empty');
  });

  it('should reject a whitespace-only username', () => {
    const result = validator.validate('   ');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Username cannot be empty');
  });

  it('should reject a username shorter than minLength', () => {
    const result = validator.validate('ab');
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('at least 3 characters');
  });

  it('should reject a username longer than maxLength', () => {
    const longName = 'a'.repeat(65);
    const result = validator.validate(longName);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('at most 64 characters');
  });

  it('should reject a username with invalid characters', () => {
    const result = validator.validate('john doe!');
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('may only contain');
  });

  it('should reject reserved usernames (case-insensitive)', () => {
    const result = validator.validate('Admin');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'This username is reserved and cannot be used',
    );
  });

  it('should reject all default reserved names', () => {
    for (const reserved of DEFAULT_USERNAME_POLICY.reservedNames) {
      const result = validator.validate(reserved);
      expect(result.valid).toBe(false);
    }
  });

  it('should accept email-style usernames', () => {
    const result = validator.validate('user@example.com');
    expect(result.valid).toBe(true);
  });

  it('should accept a username with hyphens', () => {
    const result = validator.validate('john-doe');
    expect(result.valid).toBe(true);
  });

  it('should allow custom policy to override minLength', () => {
    const custom = new UsernameValidator({ minLength: 5 });
    const result = custom.validate('abc');
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('at least 5 characters');
  });

  it('should allow custom policy to override reservedNames', () => {
    const custom = new UsernameValidator({ reservedNames: ['blocked'] });
    expect(custom.validate('admin').valid).toBe(true);
    expect(custom.validate('blocked').valid).toBe(false);
  });

  it('should collect multiple errors at once', () => {
    const custom = new UsernameValidator({ minLength: 10, pattern: /^[a-z]+$/, patternDescription: 'lowercase letters' });
    const result = custom.validate('AB');
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});
