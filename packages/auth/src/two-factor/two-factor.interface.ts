/**
 * Two-factor authentication interfaces.
 *
 * Reference: hsweb-framework twofactor package
 */

export interface TwoFactorValidator {
  /**
   * Returns the provider identifier.
   */
  getProvider(): string;

  /**
   * Verify a code and keep the validation valid until timeout elapses.
   */
  verify(code: string, timeout: number): Promise<boolean> | boolean;

  /**
   * Whether the current validation has expired.
   */
  expired(): Promise<boolean> | boolean;
}

export interface TwoFactorValidatorProvider {
  /**
   * Returns the provider identifier (e.g., 'totp', 'sms').
   */
  getProvider(): string;

  /**
   * Create a validator instance for a specific user and operation.
   */
  createTwoFactorValidator(userId: string, operation: string): TwoFactorValidator;
}
