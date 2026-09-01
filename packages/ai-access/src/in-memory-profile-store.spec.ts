import { describe, expect, it } from 'vitest';
import type { CredentialProfile } from './contracts';
import { InMemoryCredentialProfileStore } from './in-memory-profile-store';

const profile = (name = 'default'): CredentialProfile => ({
  id: `fake:${name}`,
  providerId: 'fake',
  profileName: name,
  authMethod: 'device-code',
  ownership: 'managed',
  credential: {
    kind: 'oauth',
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: 1_900_000_000_000,
  },
  expiresAt: 1_900_000_000_000,
  metadata: { createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000 },
});

describe('InMemoryCredentialProfileStore', () => {
  it('保存、列出和删除 Profile', async () => {
    const store = new InMemoryCredentialProfileStore();
    await store.save(profile());
    await store.save(profile('work'));

    await expect(store.get('fake')).resolves.toEqual(profile());
    await expect(store.list('fake')).resolves.toHaveLength(2);
    await expect(store.remove('fake', 'work')).resolves.toBe(true);
    await expect(store.list('fake')).resolves.toHaveLength(1);
  });

  it('同一个 Profile 的操作会串行执行', async () => {
    const store = new InMemoryCredentialProfileStore();
    const events: string[] = [];
    let releaseFirst = () => {};
    const blocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = store.runExclusive('fake:default', async () => {
      events.push('first:start');
      await blocked;
      events.push('first:end');
    });
    await Promise.resolve();
    const second = store.runExclusive('fake:default', async () => {
      events.push('second:start');
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(events).toEqual(['first:start']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });
});
