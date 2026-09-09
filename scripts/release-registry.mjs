import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';

export function createRegistryReader(registry, { request = globalThis.fetch, sleep = wait, onPending = () => {} } = {}) {
  async function document(name, version, tags = false) {
    if (!/^@[a-z0-9._-]+\/[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error('Invalid registry package name');
    const encodedName = name.replace('/', '%2F');
    const path = tags ? `-/package/${encodedName}/dist-tags`
      : `${encodedName}${version ? `/${encodeURIComponent(version)}` : ''}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const url = new URL(path, registry.endsWith('/') ? registry : `${registry}/`);
      // Registry edges can cache the 404 read before a package's first publish.
      // Use a unique, credential-free read URL as well as revalidation headers.
      url.searchParams.set('release_check', randomUUID());
      let response;
      try {
        response = await request(url, { headers: { accept: 'application/json', 'cache-control': 'no-cache' },
          redirect: 'error', signal: AbortSignal.timeout(10000) });
      } catch (error) {
        if (attempt === 2) throw new Error(`Registry request failed for ${name}`, { cause: error });
        await sleep(500 * 2 ** attempt);
        continue;
      }
      if (response.status === 404) { await response.body?.cancel(); return undefined; }
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        await response.body?.cancel();
        await sleep(500 * 2 ** attempt);
        continue;
      }
      if (!response.ok) throw new Error(`Registry metadata request failed (${response.status}) for ${name}`);
      return response.json();
    }
  }

  async function version(name, expectedVersion) {
    const metadata = await document(name, expectedVersion);
    if (metadata === undefined) return undefined;
    if (metadata.name !== name || metadata.version !== expectedVersion || !/^[a-f0-9]{40}$/.test(metadata.dist?.shasum ?? '')) {
      throw new Error(`Unexpected registry version metadata for ${name}@${expectedVersion}`);
    }
    return metadata;
  }

  async function afterPublish(read, description) {
    // npm can acknowledge a successful publish before its asynchronous processing
    // exposes the version. Allow five minutes of backoff without retrying a PUT.
    for (let attempt = 0; attempt < 24; attempt++) {
      const metadata = await read();
      if (metadata !== undefined) return metadata;
      if (attempt < 23) {
        onPending(description);
        await sleep(Math.min(1000 * 2 ** attempt, 15000));
      }
    }
    throw new Error(`Registry did not expose ${description} after publishing; retry the same approved bundle later`);
  }

  return {
    version,
    async verifyVersion(name, expectedVersion, expectedSha1) {
      const metadata = await afterPublish(() => version(name, expectedVersion), `${name}@${expectedVersion}`);
      if (metadata.dist.shasum !== expectedSha1) throw new Error(`Registry checksum verification failed after publishing ${name}@${expectedVersion}`);
    },
    async verifyTag(name, expectedVersion, tag) {
      const metadata = await afterPublish(() => document(name, undefined, true), `${name} tags`);
      if (metadata?.[tag] !== expectedVersion) {
        throw new Error(`Registry tag verification failed: ${name}@${tag} does not select ${expectedVersion}`);
      }
    },
  };
}
