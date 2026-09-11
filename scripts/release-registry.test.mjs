import assert from 'node:assert/strict';
import test from 'node:test';
import { createRegistryReader } from './release-registry.mjs';

const name = '@zucker-framework/core', version = '1.0.0', shasum = 'a'.repeat(40);
const metadata = { name, version, dist: { shasum }, 'dist-tags': { latest: version } };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('reads tags through the native dist-tags endpoint rather than the delayed package index', async () => {
  const reader = createRegistryReader('https://registry.npmjs.org/', {
    request: async url => {
      assert.equal(new URL(url).pathname, '/-/package/@zucker-framework%2Fcore/dist-tags');
      return response({ latest: version });
    },
  });
  await reader.verifyTag(name, version, 'latest');
});

test('uses fresh version-specific reads and tolerates a temporarily missing post-publish document', async () => {
  const urls = [], waits = [];
  let versions = 0;
  const reader = createRegistryReader('https://registry.npmjs.org/', {
    request: async (url, options) => {
      urls.push(String(url));
      assert.equal(options.headers['cache-control'], 'no-cache');
      assert.equal(options.headers.authorization, undefined);
      if (!new URL(url).pathname.endsWith('/1.0.0')) return response({}, 404);
      return ++versions < 3 ? response({ error: 'not found' }, 404) : response(metadata);
    },
    sleep: async ms => { waits.push(ms); },
  });
  assert.equal(await reader.version(name, version), undefined);
  await reader.verifyVersion(name, version, shasum);
  assert.equal(new Set(urls).size, 5);
  assert(urls.every(url => new URL(url).searchParams.has('release_check')));
  assert.deepEqual(waits, [1000]);
});

test('verifies the package-index version when the version route still returns 404', async () => {
  const urls = [];
  const reader = createRegistryReader('https://registry.npmjs.org/', {
    request: async url => {
      urls.push(new URL(url).pathname);
      return urls.length === 1 ? response({}, 404) : response({ name, versions: { [version]: metadata } });
    },
    sleep: async () => assert.fail('Visible immutable metadata needs no propagation wait'),
  });
  await reader.verifyVersion(name, version, shasum);
  assert.deepEqual(urls, ['/@zucker-framework%2Fcore/1.0.0', '/@zucker-framework%2Fcore']);
});

test('the index fallback retains identity and checksum checks and rejects malformed metadata', async () => {
  const indexReader = body => createRegistryReader('https://registry.npmjs.org/', {
    request: async url => new URL(url).pathname.endsWith('/1.0.0') ? response({}, 404) : response(body),
    sleep: async () => assert.fail('Invalid metadata must not be retried'),
  });
  await assert.rejects(indexReader({ name, versions: { [version]: metadata } }).verifyVersion(name, version, 'b'.repeat(40)), /checksum verification failed/);
  await assert.rejects(indexReader({ name, versions: { [version]: { ...metadata, name: '@other/core' } } }).version(name, version), /Unexpected registry version metadata/);
  await assert.rejects(indexReader({ name: '@other/core', versions: {} }).version(name, version), /Unexpected registry package metadata/);
  await assert.rejects(indexReader({ name }).version(name, version), /Unexpected registry package metadata/);
  await assert.rejects(indexReader(null).version(name, version), /Unexpected registry package metadata/);
  assert.equal(await indexReader({ name, versions: {} }).version(name, version), undefined);
});

test('never retries checksum, identity or tag conflicts as propagation delays', async () => {
  const sleep = async () => assert.fail('A real conflict must not be hidden by retrying');
  const reader = createRegistryReader('https://registry.npmjs.org/', { request: async () => response(metadata), sleep });
  await assert.rejects(reader.verifyVersion(name, version, 'b'.repeat(40)), /checksum verification failed/);
  await assert.rejects(reader.verifyTag(name, '1.1.0', 'latest'), /tag verification failed/);
  const invalid = createRegistryReader('https://registry.npmjs.org/', { request: async () => response({ ...metadata, name: '@other/core' }), sleep });
  await assert.rejects(invalid.version(name, version), /Unexpected registry version metadata/);
});

test('bounds transient retries and refuses authentication failures or permanently absent versions', async () => {
  let calls = 0;
  const recovering = createRegistryReader('https://registry.npmjs.org/', {
    request: async () => ++calls === 1 ? response({}, 503) : response(metadata), sleep: async () => {},
  });
  assert.equal((await recovering.version(name, version)).dist.shasum, shasum);
  assert.equal(calls, 2);
  const unauthorized = createRegistryReader('https://registry.npmjs.org/', { request: async () => response({}, 403), sleep: async () => assert.fail('403 must fail immediately') });
  await assert.rejects(unauthorized.version(name, version), /failed \(403\)/);
  let missing = 0, elapsed = 0;
  const absent = createRegistryReader('https://registry.npmjs.org/', { request: async () => { missing++; return response({}, 404); }, sleep: async ms => { elapsed += ms; } });
  await assert.rejects(absent.verifyVersion(name, version, shasum), /did not expose/);
  assert.equal(missing, 48);
  assert.equal(elapsed, 300000);
});

test('accepts a published version that remains in npm processing for over a minute', async () => {
  let calls = 0, elapsed = 0, notices = 0;
  const reader = createRegistryReader('https://registry.npmjs.org/', {
    request: async url => !new URL(url).pathname.endsWith('/1.0.0') || ++calls < 10 ? response({}, 404) : response(metadata),
    sleep: async ms => { elapsed += ms; }, onPending: () => { notices++; },
  });
  await reader.verifyVersion(name, version, shasum);
  assert.equal(calls, 10);
  assert.equal(notices, 9);
  assert(elapsed > 60000 && elapsed < 300000);
});
