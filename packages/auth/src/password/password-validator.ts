/**
 * Password strength validation.
 */

export interface PasswordPolicy {
  minLength: number;
  maxLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireDigit: boolean;
  requireSpecialChar: boolean;
  specialChars?: string;
}

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 8,
  maxLength: 128,
  requireUppercase: true,
  requireLowercase: true,
  requireDigit: true,
  requireSpecialChar: false,
  specialChars: '!@#$%^&*()_+-=[]{}|;:,.<>?',
};

/**
 * Shared validation result — same shape as UsernameValidationResult.
 * Unified to avoid duplicating the {valid, errors} interface.
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** @deprecated Use {@link ValidationResult} instead */
export type PasswordValidationResult = ValidationResult;

export class PasswordValidator {
  private readonly policy: PasswordPolicy;

  constructor(policy?: Partial<PasswordPolicy>) {
    this.policy = { ...DEFAULT_PASSWORD_POLICY, ...policy };
  }

  validate(password: string): ValidationResult {
    const errors: string[] = [];

    if (password.length < this.policy.minLength) {
      errors.push(`Password must be at least ${this.policy.minLength} characters`);
    }

    if (password.length > this.policy.maxLength) {
      errors.push(`Password must be at most ${this.policy.maxLength} characters`);
    }

    if (this.policy.requireUppercase && !/[A-Z]/.test(password)) {
      errors.push('Password must contain at least one uppercase letter');
    }

    if (this.policy.requireLowercase && !/[a-z]/.test(password)) {
      errors.push('Password must contain at least one lowercase letter');
    }

    if (this.policy.requireDigit && !/\d/.test(password)) {
      errors.push('Password must contain at least one digit');
    }

    if (this.policy.requireSpecialChar) {
      const chars = this.policy.specialChars ?? DEFAULT_PASSWORD_POLICY.specialChars!;
      const hasSpecial = password.split('').some((c) => chars.includes(c));
      if (!hasSpecial) {
        errors.push('Password must contain at least one special character');
      }
    }

    return { valid: errors.length === 0, errors };
  }
}
