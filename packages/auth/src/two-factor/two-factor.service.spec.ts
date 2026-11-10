import { describe, expect, it, vi } from 'vitest';
import { TwoFactorService } from './two-factor.service';
import type {
  TwoFactorValidator,
  TwoFactorValidatorProvider,
} from './two-factor.interface';

describe('TwoFactorService', () => {
  it('passes userId and operation into provider-created validator', async () => {
    const verify = vi.fn().mockResolvedValue(true);
    const expired = vi.fn().mockResolvedValue(true);
    const createTwoFactorValidator = vi.fn().mockReturnValue({
      getProvider: () => 'totp',
      verify,
      expired,
    } satisfies TwoFactorValidator);
    const provider: TwoFactorValidatorProvider = {
      getProvider: () => 'totp',
      createTwoFactorValidator,
    };
    const service = new TwoFactorService([provider]);

    const validator = service.getValidator('u1', 'transfer', 'totp');
    await service.validate('u1', 'totp', '123456', 'transfer', 30000);

    expect(validator).toBeDefined();
    expect(createTwoFactorValidator).toHaveBeenCalledWith('u1', 'transfer', undefined);
    expect(verify).toHaveBeenCalledWith('123456', 30000);
  });
});
