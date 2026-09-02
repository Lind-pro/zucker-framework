import { credentialProfileId, type CredentialProfile, type CredentialProfileStore } from './contracts';

export class InMemoryCredentialProfileStore implements CredentialProfileStore {
  private readonly profiles = new Map<string, CredentialProfile>();
  private readonly locks = new Map<string, Promise<void>>();

  async get(providerId: string, profileName = 'default'): Promise<CredentialProfile | null> {
    const profile = this.profiles.get(credentialProfileId(providerId, profileName));
    return profile ? structuredClone(profile) : null;
  }

  async list(providerId?: string): Promise<CredentialProfile[]> {
    return [...this.profiles.values()]
      .filter((profile) => !providerId || profile.providerId === providerId)
      .map((profile) => structuredClone(profile));
  }

  async save(profile: CredentialProfile): Promise<void> {
    this.profiles.set(profile.id, structuredClone(profile));
  }

  async remove(providerId: string, profileName = 'default'): Promise<boolean> {
    return this.profiles.delete(credentialProfileId(providerId, profileName));
  }

  async runExclusive<T>(profileId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(profileId) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.locks.set(profileId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(profileId) === queued) this.locks.delete(profileId);
    }
  }
}
