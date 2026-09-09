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
  const reader = createRegistryReader('https://registry.npmjs.org/', {
    request: async (url, options) => {
      urls.push(String(url));
      assert.equal(options.headers['cache-control'], 'no-cache');
      assert.equal(options.headers.authorization, undefined);
      return urls.length < 3 ? response({ error: 'not found' }, 404) : response(metadata);
    },
    sleep: async ms => { waits.push(ms); },
  });
  assert.equal(await reader.version(name, version), undefined);
  await reader.verifyVersion(name, version, shasum);
  assert.equal(new Set(urls).size, 3);
  assert(urls.every(url => new URL(url).pathname.endsWith('/1.0.0') && new URL(url).searchParams.has('release_check')));
  assert.deepEqual(waits, [500]);
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
  let missing = 0;
  const absent = createRegistryReader('https://registry.npmjs.org/', { request: async () => { missing++; return response({}, 404); }, sleep: async () => {} });
  await assert.rejects(absent.verifyVersion(name, version, shasum), /did not expose/);
  assert.equal(missing, 5);
});
