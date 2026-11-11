import type { DatabaseAdapter } from '@zucker-framework/core';
import { requireSql, resolveAccountsOptions, table, type AccountTableKey, type ResolvedAccountsOptions } from '../accounts.options';
import type { AccountDeletionContributor } from './account-deletion.types';

/**
 * Erase steps of the account host's own data, by fixed parameterised SQL over the configured tables.
 * Each statement is idempotent; tables of disabled features (and optional link tables mapped to
 * `null`) are never touched. Orders 400–800 leave room for product contributors before and after.
 */
export function accountDeletionContributors(options: ResolvedAccountsOptions = resolveAccountsOptions()): AccountDeletionContributor<DatabaseAdapter>[] {
  const { features, tables } = options;
  const quoted = (key: AccountTableKey) => (tables[key] ? table(options, key) : null);
  const sessions = quoted('accountSessions')!;
  const deleteFrom = async (tx: DatabaseAdapter, key: AccountTableKey, userId: string) => {
    const name = quoted(key);
    if (name) await requireSql(options, tx, 'Account deletion').query(`DELETE FROM ${name} WHERE "userId" = $1`, [userId]);
  };
  const contributors: AccountDeletionContributor<DatabaseAdapter>[] = [];
  if (features.apiKeys) contributors.push({
    name: 'api-keys', order: 400,
    async erase(tx, userId) { await deleteFrom(tx, 'accountApiKeyUsage', userId); await deleteFrom(tx, 'accountApiKeys', userId); },
  });
  /** Sessions, tickets (including the cancel-deletion ticket), OAuth intents/proofs/bindings, legacy tokens. */
  contributors.push({
    name: 'sessions', order: 500,
    async erase(tx, userId) {
      const sql = requireSql(options, tx, 'Account deletion');
      if (features.oauth) {
        for (const key of ['accountOAuthProofs', 'accountOAuthIntents'] as const) {
          await sql.query(`DELETE FROM ${quoted(key)} WHERE "userId" = $1 OR "sessionId" IN (SELECT id FROM ${sessions} WHERE "userId" = $1)`, [userId]);
        }
      }
      await deleteFrom(tx, 'accountSessions', userId);
      await deleteFrom(tx, 'accountTickets', userId);
      if (features.oauth) await deleteFrom(tx, 'thirdPartyBinds', userId);
      await deleteFrom(tx, 'userTokens', userId);
    },
  });
  /** Role, permission, data-permission, dimension and settings links; notification subscriptions. */
  contributors.push({
    name: 'authorization', order: 600,
    async erase(tx, userId) {
      for (const key of ['userRoles', 'userPermissions', 'userDataPermissions', 'dimensionUsers', 'userSettings', 'notifySubscribers'] as const) {
        await deleteFrom(tx, key, userId);
      }
    },
  });
  contributors.push({
    name: 'sign-in-history', order: 700,
    async erase(tx, userId) { await deleteFrom(tx, 'userLoginHistory', userId); await deleteFrom(tx, 'userAcquisition', userId); },
  });
  if (features.twoFactor) contributors.push({
    name: 'two-factor', order: 800,
    async erase(tx, userId) { await deleteFrom(tx, 'accountRecoveryCodes', userId); await deleteFrom(tx, 'accountTwoFactor', userId); },
  });
  return contributors;
}
