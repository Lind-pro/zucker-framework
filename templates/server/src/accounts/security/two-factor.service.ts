import { Inject, Injectable, Optional } from '@nestjs/common';
import { DATABASE_ADAPTER, type DatabaseAdapter } from '@zucker-framework/core';
import { ACCOUNTS_CLOCK, AccountTwoFactorService as HostTwoFactorService, type AccountSecurityClock } from '@zucker-framework/back-office/accounts';
import { RUNTIME_ENVIRONMENT } from '../../runtime-settings/runtime-settings.tokens';

export { secondFactor, TOTP_PERIOD_SECONDS, TOTP_WINDOW, RECOVERY_CODE_COUNT, type SecondFactor, type TwoFactorRow, type TwoFactorStatus } from '@zucker-framework/back-office/accounts';

/** Issuer label in authenticator apps: `SITE_NAME`, else the `WEB_URL` host, else "Zucker". */
function issuerName(env: Readonly<NodeJS.ProcessEnv>): string {
  const site = env.SITE_NAME?.replace(/[\u0000-\u001f\u007f:]/g, '').trim();
  if (site) return site;
  try { return env.WEB_URL ? new URL(env.WEB_URL).host : 'Zucker'; } catch { return 'Zucker'; }
}

/** TOTP keyed by `CONFIG_ENCRYPTION_KEY` (≥ 32 characters, different from JWT_SECRET) of the runtime environment. */
@Injectable()
export class AccountTwoFactorService extends HostTwoFactorService {
  constructor(@Inject(DATABASE_ADAPTER) db: DatabaseAdapter, @Inject(ACCOUNTS_CLOCK) clock: AccountSecurityClock,
    @Optional() @Inject(RUNTIME_ENVIRONMENT) environment?: Readonly<NodeJS.ProcessEnv>) {
    const env = environment ?? process.env;
    super(db, clock, { encryptionKey: env.CONFIG_ENCRYPTION_KEY, distinctFrom: [env.JWT_SECRET], issuer: issuerName(env) });
  }
}
