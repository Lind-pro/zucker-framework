import { describe, expect, it } from 'vitest';
import { APP_DELETION_CONTRIBUTORS } from '../src/accounts/deletion/app-contributors';
import { builtInDeletionContributors, orderContributors, type AccountDeletionContributor } from '../src/accounts/deletion';
import type { ApplicationDatabase } from '../src/database';

/**
 * The application's account-deletion registry (built-ins + `APP_DELETION_CONTRIBUTORS` as composed in
 * app.module): every Phase 3 feature that stores personal data is registered, names are unique, and the
 * erase order keeps its invariants (referrals before any credit-account lock, AI cancellation before the
 * AI-task erase, file cleanup after the file tombstones).
 */
describe('account deletion registry (application composition)', () => {
  const database = {} as ApplicationDatabase;
  const resolve = (entry: (typeof APP_DELETION_CONTRIBUTORS)[number]): AccountDeletionContributor => {
    if (!('useFactory' in entry)) return entry;
    // Structural fakes of the injected services; erase is never called here.
    const fakes: Record<string, unknown> = { AITasksService: { tasks: { cancel: async () => undefined } }, FilesService: { recover: async () => undefined } };
    const args = (entry.inject ?? []).map(token => typeof token === 'function' ? fakes[token.name] : database);
    return (entry.useFactory as (...values: unknown[]) => AccountDeletionContributor)(...args);
  };
  const registry = orderContributors([...builtInDeletionContributors(database), ...APP_DELETION_CONTRIBUTORS.map(resolve)]);

  it('registers every feature contributor exactly once, in the documented order', () => {
    expect(registry.map(contributor => `${contributor.name}:${contributor.order}`)).toEqual([
      'referrals:10', 'feedback:50', 'inbox:60', 'ai-task-cancellation:90', 'ai-tasks:100', 'chats:110', 'record-jobs:120',
      'files:200', 'private-file-cleanup:210', 'credits:300', 'api-keys:400', 'sessions:500', 'authorization:600',
      'sign-in-history:700', 'two-factor:800', 'logs:900',
    ]);
  });

  it('keeps the ordering invariants', () => {
    const at = (name: string) => registry.findIndex(contributor => contributor.name === name);
    expect(at('referrals')).toBeLessThan(at('credits'));
    expect(at('ai-task-cancellation')).toBeLessThan(at('ai-tasks'));
    expect(at('private-file-cleanup')).toBeGreaterThan(at('files'));
    expect(registry.find(contributor => contributor.name === 'ai-task-cancellation')?.onScheduled).toBeTypeOf('function');
    expect(registry.find(contributor => contributor.name === 'private-file-cleanup')?.afterCommit).toBeTypeOf('function');
  });

  it('refuses a duplicate registration at start-up', () => {
    expect(() => orderContributors([...registry, registry[0]])).toThrow(/registered twice/);
  });
});
