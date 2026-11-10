import { Inject, Injectable } from '@nestjs/common';
import { DATABASE_ADAPTER, type DatabaseAdapter } from '@zucker-framework/core';
import type { AdminUserHooks, AdminUserSensitiveChange } from '@zucker-framework/admin';

/** Fields whose change by an administrator must end the account's existing sessions. */
const SESSION_ENDING_FIELDS = new Set(['password', 'email', 'status']);

/**
 * Applies the template's session model to back-office user changes: a password reset, e-mail
 * change or disable by an administrator bumps `credentialVersion` (invalidating access tokens,
 * e-mail tickets and file-download tickets) and revokes every open refresh session, exactly like a
 * self-service password change.
 */
@Injectable()
export class AdminUserSessionHooks implements AdminUserHooks {
  constructor(@Inject(DATABASE_ADAPTER) private readonly db: DatabaseAdapter) {}

  async sensitiveFieldsChanged(change: AdminUserSensitiveChange): Promise<void> {
    if (!change.fields.some(field => SESSION_ENDING_FIELDS.has(field))) return;
    await this.db.$transaction(async tx => {
      await tx.model('users').updateMany({ where: { id: change.userId }, data: { credentialVersion: { increment: 1 } } });
      await tx.model('accountSessions').updateMany({ where: { userId: change.userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'admin-credential-change' } });
    });
  }
}
