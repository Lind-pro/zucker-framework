import { Injectable, Inject, Optional, Logger } from '@nestjs/common';
import type {
  TwoFactorValidator,
  TwoFactorValidatorProvider,
} from './two-factor.interface';

export const TWO_FACTOR_PROVIDERS = Symbol('TWO_FACTOR_PROVIDERS');

@Injectable()
export class TwoFactorService {
  private readonly logger = new Logger(TwoFactorService.name);
  private readonly providerMap = new Map<string, TwoFactorValidatorProvider>();

  constructor(
    @Optional()
    @Inject(TWO_FACTOR_PROVIDERS)
    providers?: TwoFactorValidatorProvider[] | null,
  ) {
    if (providers) {
      for (const provider of providers) {
        this.providerMap.set(provider.getProvider(), provider);
      }
      this.logger.log(
        `Registered ${this.providerMap.size} two-factor providers: ${Array.from(this.providerMap.keys()).join(', ')}`,
      );
    }
  }

  registerProvider(provider: TwoFactorValidatorProvider): void {
    this.providerMap.set(provider.getProvider(), provider);
  }

  getProvider(name: string): TwoFactorValidatorProvider | undefined {
    return this.providerMap.get(name);
  }

  getAvailableProviders(): string[] {
    return Array.from(this.providerMap.keys());
  }

  /**
   * Validate a two-factor code.
   * @param userId - the user ID
   * @param provider - the provider name (e.g. 'totp', 'sms')
   * @param code - the verification code
   * @param operation - the operation requiring 2FA
   */
  async validate(
    userId: string,
    provider: string,
    code: string,
    operation: string,
    timeout: number,
  ): Promise<boolean> {
    const validator = this.getValidator(userId, operation, provider);
    if (!validator) {
      return false;
    }
    return validator.verify(code, timeout);
  }

  /**
   * Get a validator for a user/operation.
   */
  getValidator(
    userId: string,
    operation: string,
    provider: string,
    /** Scopes a successful verification to one session (token/jti) instead of every session of the user. */
    sessionId?: string,
  ): TwoFactorValidator | undefined {
    const validatorProvider = this.providerMap.get(provider);
    if (!validatorProvider) {
      this.logger.warn(`Two-factor provider not found: ${provider}`);
      return undefined;
    }
    return validatorProvider.createTwoFactorValidator(userId, operation, sessionId);
  }
}
