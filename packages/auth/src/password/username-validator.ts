/**
 * Username validation — mirrors hsweb UsernameValidator.
 *
 * Reference: hsweb-framework UsernameValidator interface
 *
 * Provides configurable username policy enforcement including:
 * - Length constraints
 * - Character restrictions (alphanumeric, email format, etc.)
 * - Reserved name blocking
 */

import { type ValidationResult } from './password-validator';

export interface UsernamePolicy {
  minLength: number;
  maxLength: number;
  /** Allowed character pattern (regex). Default: alphanumeric + underscore + dot + @ */
  pattern: RegExp;
  /** Human-readable description of the pattern for error messages */
  patternDescription: string;
  /** Reserved usernames that cannot be used */
  reservedNames: string[];
}

export const DEFAULT_USERNAME_POLICY: UsernamePolicy = {
  minLength: 3,
  maxLength: 64,
  pattern: /^[a-zA-Z0-9_.@-]+$/,
  patternDescription: 'letters, digits, underscore, dot, @ and hyphen',
  reservedNames: [
    'admin',
    'administrator',
    'root',
    'system',
    'superuser',
    'null',
    'undefined',
  ],
};

export interface UsernameValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * UsernameValidator — configurable username policy enforcement.
 *
 * Reference: hsweb UsernameValidator
 */
export class UsernameValidator {
  private readonly policy: UsernamePolicy;

  constructor(policy?: Partial<UsernamePolicy>) {
    this.policy = { ...DEFAULT_USERNAME_POLICY, ...policy };
  }

  validate(username: string): UsernameValidationResult {
    const errors: string[] = [];

    if (!username || username.trim().length === 0) {
      errors.push('Username cannot be empty');
      return { valid: false, errors };
    }

    const trimmed = username.trim();

    if (trimmed.length < this.policy.minLength) {
      errors.push(`Username must be at least ${this.policy.minLength} characters`);
    }

    if (trimmed.length > this.policy.maxLength) {
      errors.push(`Username must be at most ${this.policy.maxLength} characters`);
    }

    if (!this.policy.pattern.test(trimmed)) {
      errors.push(
        `Username may only contain ${this.policy.patternDescription}`,
      );
    }

    if (
      this.policy.reservedNames.some(
        (r) => r.toLowerCase() === trimmed.toLowerCase(),
      )
    ) {
      errors.push('This username is reserved and cannot be used');
    }

    return { valid: errors.length === 0, errors };
  }
}
