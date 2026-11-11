import type { BackOfficeAccountsOptions } from '@zucker-framework/back-office/accounts';
import { MAIL_ACCOUNT_MAILER } from '@zucker-framework/back-office/mail';
import { MailCoreModule } from '../mail/mail.module';
import { AccountOnboarding } from './account-onboarding';
import { assertNoOpenBilling } from './deletion/account-deletion.service';
import { AccountTwoFactorService } from './security/two-factor.service';

/** `ai:generate` admits `/v1/ai/tasks*` (AI_GENERATE_SCOPE in ../ai-tasks). */
export const ACCOUNT_KEY_SCOPES = ['account:read', 'ai:generate'] as const;

/**
 * Template composition of the account host. OAuth, API keys, deletion and avatars are separate template
 * modules (`mount: false`): the core honours them, their own modules mount the routes. Environment values
 * are read lazily, when the host's classes are constructed.
 */
export function templateAccountOptions(): BackOfficeAccountsOptions {
  return {
    origins: () => (process.env.ACCOUNT_ORIGINS ?? 'http://localhost:4201,http://localhost:4202').split(','),
    cookie: { name: 'zucker-session', path: '/', sameSite: 'lax', secure: () => process.env.NODE_ENV === 'production' },
    mailer: { useExisting: MAIL_ACCOUNT_MAILER }, policy: AccountOnboarding, signupHooks: AccountOnboarding, imports: [MailCoreModule],
    features: {
      twoFactor: { service: AccountTwoFactorService },
      oauth: { mount: false, returnPaths: { exact: ['/account', '/dashboard', '/billing/orders', '/billing/return', '/pricing'],
        prefixes: ['/content/manage', '/billing/subscriptions'] } },
      apiKeys: { mount: false, scopes: ACCOUNT_KEY_SCOPES, defaultScopes: ['account:read'] },
      deletion: { mount: false, assertDeletable: assertNoOpenBilling, clearUserFields: { avatarFileId: null, deviceInfo: null, lastLoginIp: null } },
      avatar: { mount: false },
    },
  };
}
