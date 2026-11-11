import { Module, type DynamicModule, type InjectionToken, type Provider, type Type } from '@nestjs/common';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { AccountSessionAdminHooks } from './admin-user-hooks';
import { systemAccountSecurityClock } from './account-security';
import { AccountSessionCookie } from './account-session-cookie';
import { createAccountController } from './account.controller';
import { AccountGuard } from './account.guard';
import { AccountService } from './account.service';
import { resolveAccountsOptions, type AccountPortRef, type BackOfficeAccountsOptions, type ResolvedAccountsOptions } from './accounts.options';
import type { AccountAccessTokenVerifier } from './accounts.ports';
import {
  ACCOUNTS_ACCESS_VERIFIERS, ACCOUNTS_API_KEY_AUTHENTICATOR, ACCOUNTS_AVATAR_STORAGE, ACCOUNTS_AVATAR_UPLOAD, ACCOUNTS_CLOCK, ACCOUNTS_DELETION_CONTRIBUTORS,
  ACCOUNTS_DELETION_SCHEDULER, ACCOUNTS_MAILER, ACCOUNTS_OAUTH_PROVIDER_CLIENT, ACCOUNTS_OAUTH_SETTINGS, ACCOUNTS_OPTIONS, ACCOUNTS_PASSWORD_ENCODER,
  ACCOUNTS_POLICY, ACCOUNTS_SIGNUP_HOOKS, ACCOUNTS_TWO_FACTOR_KEYS, ACCOUNTS_VERIFICATION_ATTEMPTS,
} from './accounts.tokens';
import { ACCOUNT_API_KEY_SERVICE_PROVIDER, AccountApiKeyAuthenticator, AccountApiKeysService } from './api-keys/api-keys.service';
import { AccountApiKeysController, ApiKeyAccountController } from './api-keys/api-keys.controller';
import { AccountAvatarController, AccountAvatarUploadInterceptor } from './avatar/avatar.controller';
import { AccountAvatarService } from './avatar/avatar.service';
import { accountDeletionContributors } from './deletion/account-deletion.contributors';
import { AccountDeletionController } from './deletion/account-deletion.controller';
import { AccountDeletionService } from './deletion/account-deletion.service';
import { orderContributors, type AccountDeletionContributor } from './deletion/account-deletion.types';
import { ConfiguredOAuthProviderClient } from './oauth/oauth-provider';
import { OAuthController } from './oauth/oauth.controller';
import { OAuthService } from './oauth/oauth.service';
import { AccountTwoFactorAdminController, AccountTwoFactorController } from './two-factor/two-factor.controller';
import { AccountTwoFactorService } from './two-factor/two-factor.service';

const isClass = (value: unknown): value is Type<unknown> => typeof value === 'function';
const isPortRef = (value: unknown): value is AccountPortRef =>
  !!value && typeof value === 'object' && Object.keys(value).length === 1 && 'useExisting' in value
  && (typeof (value as AccountPortRef).useExisting === 'symbol' || typeof (value as AccountPortRef).useExisting === 'string' || typeof (value as AccountPortRef).useExisting === 'function');

/**
 * The account host (`/authorize/*`). `forRoot` resolves the options at startup (misconfiguration throws)
 * and mounts the core routes plus every enabled feature whose `mount` is not `false`. A feature with
 * `mount: false` is still honoured by the core (pending deletions refuse sign-in, enrolled two-factor
 * is asked for); its routes are then composed by the consumer from the exported classes. Global modules
 * (`DATABASE_ADAPTER`, `ZuckerAuthModule`/`JwtService`, rate limiter, logging) come from the root.
 * Register `AccountGuard` as the root `APP_GUARD` (it is exported with everything it needs).
 */
@Module({})
export class BackOfficeAccountsModule {
  static forRoot(input: BackOfficeAccountsOptions): DynamicModule {
    const options = resolveAccountsOptions(input);
    if (!options.mailer) throw new TypeError('[back-office/accounts] mailer is required (AccountMailer class or object)');
    const providers: Provider[] = [], controllers: Type<unknown>[] = [], exported = new Set<InjectionToken>();
    const imports = [...options.imports];
    const classes = new Set<Type<unknown>>();
    /** A port given as a class is registered once (so one class can serve several ports) and aliased. */
    const port = (token: InjectionToken, value: unknown) => {
      if (value === undefined) return;
      if (isPortRef(value)) providers.push({ provide: token, useExisting: value.useExisting });
      else if (isClass(value)) {
        if (!classes.has(value)) { classes.add(value); providers.push(value); exported.add(value); }
        providers.push({ provide: token, useExisting: value });
      } else providers.push({ provide: token, useValue: value });
      exported.add(token);
    };
    const add = (...entries: Array<Type<unknown>>) => { for (const entry of entries) { providers.push(entry); exported.add(entry); } };

    providers.push({ provide: ACCOUNTS_OPTIONS, useValue: options }, { provide: ACCOUNTS_CLOCK, useValue: systemAccountSecurityClock });
    exported.add(ACCOUNTS_OPTIONS).add(ACCOUNTS_CLOCK);
    port(ACCOUNTS_MAILER, options.mailer);
    port(ACCOUNTS_POLICY, options.policy);
    port(ACCOUNTS_SIGNUP_HOOKS, options.signupHooks);
    port(ACCOUNTS_PASSWORD_ENCODER, options.passwordEncoder);
    port(ACCOUNTS_VERIFICATION_ATTEMPTS, options.verification.attempts);
    const verifierClasses = options.tokens.additionalAccessVerifiers.filter(isClass) as Type<AccountAccessTokenVerifier>[];
    for (const verifier of verifierClasses) if (!classes.has(verifier)) { classes.add(verifier); providers.push(verifier); }
    providers.push({ provide: ACCOUNTS_ACCESS_VERIFIERS, inject: verifierClasses,
      useFactory: (...instances: AccountAccessTokenVerifier[]) => {
        let next = 0;
        return options.tokens.additionalAccessVerifiers.map(entry => isClass(entry) ? instances[next++]! : entry as AccountAccessTokenVerifier);
      } });
    exported.add(ACCOUNTS_ACCESS_VERIFIERS);
    add(AccountService, AccountGuard, AccountSessionCookie, AccountSessionAdminHooks);
    const { features } = options;
    controllers.push(createAccountController({ features: { register: features.register, magicLink: features.magicLink, twoFactor: !!features.twoFactor } }));

    const mounted = <T extends { mount: boolean; imports?: unknown[]; providers?: Provider[] }>(feature: T | null): feature is T => {
      if (!feature?.mount) return false;
      imports.push(...((feature.imports ?? []) as NonNullable<typeof imports>));
      providers.push(...(feature.providers ?? []));
      return true;
    };

    const twoFactor = features.twoFactor;
    if (twoFactor) {
      if (twoFactor.keys) providers.push({ provide: ACCOUNTS_TWO_FACTOR_KEYS, useValue: twoFactor.keys });
      if (twoFactor.service && twoFactor.service !== AccountTwoFactorService) {
        providers.push(twoFactor.service, { provide: AccountTwoFactorService, useExisting: twoFactor.service });
        exported.add(twoFactor.service);
      } else providers.push(AccountTwoFactorService);
      exported.add(AccountTwoFactorService);
      if (mounted(twoFactor)) controllers.push(AccountTwoFactorController, AccountTwoFactorAdminController);
    }
    const oauth = features.oauth;
    if (mounted(oauth)) {
      port(ACCOUNTS_OAUTH_SETTINGS, oauth.settings);
      port(ACCOUNTS_OAUTH_PROVIDER_CLIENT, oauth.providerClient ?? ConfiguredOAuthProviderClient);
      add(OAuthService);
      controllers.push(OAuthController);
    }
    const apiKeys = features.apiKeys;
    if (mounted(apiKeys)) {
      providers.push(ACCOUNT_API_KEY_SERVICE_PROVIDER, { provide: ACCOUNTS_API_KEY_AUTHENTICATOR, useExisting: AccountApiKeyAuthenticator });
      add(AccountApiKeysService, AccountApiKeyAuthenticator);
      exported.add(ACCOUNTS_API_KEY_AUTHENTICATOR);
      controllers.push(AccountApiKeysController, ApiKeyAccountController);
    }
    const deletion = features.deletion;
    if (mounted(deletion)) {
      providers.push(...deletionContributorProviders(options));
      port(ACCOUNTS_DELETION_SCHEDULER, deletion.scheduler);
      add(AccountDeletionService);
      exported.add(ACCOUNTS_DELETION_CONTRIBUTORS);
      controllers.push(AccountDeletionController);
    }
    const avatar = features.avatar;
    if (mounted(avatar)) {
      if (!avatar.storage || !avatar.upload) throw new TypeError('[back-office/accounts] features.avatar needs storage and upload');
      port(ACCOUNTS_AVATAR_STORAGE, avatar.storage);
      port(ACCOUNTS_AVATAR_UPLOAD, avatar.upload);
      add(AccountAvatarService, AccountAvatarUploadInterceptor);
      controllers.push(AccountAvatarController);
    }
    return { module: BackOfficeAccountsModule, imports, controllers, providers, exports: [...exported] };
  }
}

/**
 * `ACCOUNTS_DELETION_CONTRIBUTORS`: the host's own erase steps plus `features.deletion.contributors`
 * (values or `{ inject, useFactory }`), ordered and checked for duplicates at start-up.
 */
export function deletionContributorProviders(options: ResolvedAccountsOptions): Provider[] {
  const providers: Provider[] = [], tokens: symbol[] = [];
  (options.features.deletion?.contributors ?? []).forEach((entry, index) => {
    const token = Symbol(`ACCOUNT_DELETION_CONTRIBUTOR_${index}`);
    tokens.push(token);
    providers.push('useFactory' in entry
      ? { provide: token, inject: entry.inject ?? [], useFactory: entry.useFactory as (...args: unknown[]) => unknown }
      : { provide: token, useValue: entry });
  });
  providers.push({ provide: ACCOUNTS_DELETION_CONTRIBUTORS, inject: [DATABASE_ADAPTER, ...tokens],
    useFactory: (_database: unknown, ...registered: AccountDeletionContributor<never>[]) =>
      orderContributors([...accountDeletionContributors(options), ...registered] as AccountDeletionContributor<never>[]) });
  return providers;
}
