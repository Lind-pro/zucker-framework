// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '@zucker-framework/core';
import { accountDeletionContributors, orderContributors, resolveAccountsOptions, type BackOfficeAccountsOptions } from '../index';

/** Runs every contributor against a recording SQL transaction and returns the statements issued. */
async function erase(options: BackOfficeAccountsOptions): Promise<{ names: string[]; sql: string[] }> {
  const resolved = resolveAccountsOptions(options);
  const sql: string[] = [];
  const tx = { query: async (statement: string, values: unknown[]) => { sql.push(`${statement} <- ${JSON.stringify(values)}`); return { rows: [] }; } } as unknown as DatabaseAdapter;
  const contributors = orderContributors(accountDeletionContributors(resolved) as never) as unknown as Array<{ name: string; erase(tx: DatabaseAdapter, userId: string): Promise<void> }>;
  for (const contributor of contributors) await contributor.erase(tx, 'user-1');
  return { names: contributors.map(contributor => contributor.name), sql };
}
const touches = (sql: string[], table: string) => sql.some(statement => statement.includes(`FROM ${table} `) || statement.includes(`FROM "${table}" `));

describe('accountDeletionContributors', () => {
  it('skips the steps and tables of disabled features', async () => {
    const { names, sql } = await erase({ features: { twoFactor: false, apiKeys: false, oauth: false } });
    expect(names).toEqual(['sessions', 'authorization', 'sign-in-history']);
    for (const table of ['account_api_keys', 'account_api_key_usage', 'account_two_factor', 'account_recovery_codes', 'third_party_binds',
      'account_oauth_intents', 'account_oauth_proofs']) expect(touches(sql, table), table).toBe(false);
    expect(touches(sql, 'account_sessions')).toBe(true);
  });

  it('enabled features add their steps in order (api keys before sessions, two-factor last)', async () => {
    const { names, sql } = await erase({ features: { twoFactor: true, apiKeys: true, oauth: true } });
    expect(names).toEqual(['api-keys', 'sessions', 'authorization', 'sign-in-history', 'two-factor']);
    for (const table of ['account_api_keys', 'account_api_key_usage', 'account_two_factor', 'account_recovery_codes', 'third_party_binds', 'account_oauth_intents'])
      expect(touches(sql, table), table).toBe(true);
    // Usage rows go before their keys.
    expect(sql.findIndex(s => s.includes('account_api_key_usage'))).toBeLessThan(sql.findIndex(s => s.includes('FROM account_api_keys ')));
  });

  it('optional link tables mapped to null are never touched; present ones are used with the user id as a parameter', async () => {
    const { sql } = await erase({ features: { twoFactor: false }, tables: { userPermissions: null, userDataPermissions: null, dimensionUsers: null,
      userSettings: null, notifySubscribers: null, userTokens: null, userLoginHistory: null, userAcquisition: 'acquisitions' } });
    for (const table of ['user_permissions', 'user_data_permissions', 'dimension_users', 'user_settings', 'notify_subscribers', 'user_tokens', 'user_login_history'])
      expect(touches(sql, table), table).toBe(false);
    expect(sql.some(s => s.startsWith('DELETE FROM acquisitions ') && s.endsWith('["user-1"]'))).toBe(true);
    expect(sql.every(s => s.includes('$1') && s.endsWith('["user-1"]'))).toBe(true); // never string-interpolated
  });

  it('uses the configured table names, quoting mixed-case ones', async () => {
    const { sql } = await erase({ features: { twoFactor: true }, tables: { accountSessions: 'AuthSessions', accountTickets: 'auth_tickets', userRoles: 'user_role_links' } });
    expect(sql.some(s => s.startsWith('DELETE FROM "AuthSessions" '))).toBe(true);
    expect(sql.some(s => s.startsWith('DELETE FROM auth_tickets '))).toBe(true);
    expect(sql.some(s => s.startsWith('DELETE FROM user_role_links '))).toBe(true);
    expect(touches(sql, 'account_sessions')).toBe(false);
  });

  it('fails clearly when the transaction cannot run SQL', async () => {
    const [sessions] = accountDeletionContributors(resolveAccountsOptions({ features: { twoFactor: false } }));
    await expect(sessions!.erase({} as DatabaseAdapter, 'u')).rejects.toThrow(/needs a transaction adapter with query/);
  });
});

describe('orderContributors', () => {
  it('orders by `order` and rejects duplicate names', () => {
    const make = (name: string, order: number) => ({ name, order, erase: async () => undefined });
    expect(orderContributors([make('b', 20), make('a', 10)] as never).map(c => c.name)).toEqual(['a', 'b']);
    expect(() => orderContributors([make('a', 1), make('a', 2)] as never)).toThrow();
  });
});
