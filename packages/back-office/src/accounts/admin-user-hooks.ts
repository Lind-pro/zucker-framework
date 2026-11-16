import { Inject, Injectable, Optional } from '@nestjs/common';
import { DATABASE_ADAPTER, type DatabaseAdapter } from '@zucker-framework/core';
import type { AdminUserHooks, AdminUserSensitiveChange } from '@zucker-framework/admin';
import { resolveAccountsOptions, type ResolvedAccountsOptions } from './accounts.options';
import { ACCOUNTS_OPTIONS } from './accounts.tokens';

/** Fields whose change by an administrator must end the account's existing sessions. */
const SESSION_ENDING_FIELDS = new Set(['password', 'email', 'status']);

/**
 * `ZuckerAdminModule.forRoot({ users: { hooks: AccountSessionAdminHooks } })`: a password reset, e-mail
 * change or disable by an administrator bumps `credentialVersion` (invalidating access tokens, e-mail
 * tickets and download tickets) and revokes every open refresh session, like a self-service password change.
 */
@Injectable()
export class AccountSessionAdminHooks implements AdminUserHooks {
  private readonly options: ResolvedAccountsOptions;
  constructor(@Inject(DATABASE_ADAPTER) private readonly db: DatabaseAdapter, @Optional() @Inject(ACCOUNTS_OPTIONS) options?: ResolvedAccountsOptions) {
    this.options = options ?? resolveAccountsOptions();
  }

  async sensitiveFieldsChanging(change: AdminUserSensitiveChange, tx: DatabaseAdapter): Promise<void> {
    if (!change.fields.some(field => SESSION_ENDING_FIELDS.has(field))) return;
    const { users, accountSessions } = this.options.models;
    await tx.model(users).updateMany({ where: { id: change.userId }, data: { credentialVersion: { increment: 1 } } });
    await tx.model(accountSessions).updateMany({ where: { userId: change.userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'admin-credential-change' } });
  }

  /** Legacy direct callers; current UsersController always supplies its update transaction. */
  async sensitiveFieldsChanged(change: AdminUserSensitiveChange): Promise<void> {
    await this.db.$transaction(tx => this.sensitiveFieldsChanging(change, tx));
  }
}
