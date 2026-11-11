import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadManifest, parseRequestPath, startFileRegistry, tarballPath } from './file-registry.mjs';

const script = fileURLToPath(new URL('./file-registry.mjs', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'zf-registry-test-'));
const VERSION = '1.2.3';
const names = ['core', 'crud'];
const bytes = Object.fromEntries(names.map((n) => [n, Buffer.from(`synthetic tarball for ${n}`)]));
let registry;

const manifestFor = (directory, entries) => {
  mkdirSync(join(directory, 'tarballs'), { recursive: true });
  for (const n of names) writeFileSync(join(directory, 'tarballs', `zucker-framework-${n}-${VERSION}.tgz`), bytes[n]);
  const file = join(directory, 'manifest.json');
  writeFileSync(file, JSON.stringify({ release: false, packages: entries }));
  return file;
};
const entry = (n) => ({
  name: `@zucker-framework/${n}`, version: VERSION, file: `zucker-framework-${n}-${VERSION}.tgz`,
  integrity: `sha512-${createHash('sha512').update(bytes[n]).digest('base64')}`, shasum: createHash('sha1').update(bytes[n]).digest('hex'),
  packageJson: { name: `@zucker-framework/${n}`, version: VERSION, devDependencies: { x: '1' }, scripts: { build: 'tsc', postinstall: 'true' } },
});

/** Raw request: fetch/URL would normalise `..` away before it reaches the server. */
const raw = (path, { method = 'GET', port = registry.port } = {}) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path, method }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
  });
  req.on('error', reject);
  req.end();
});

before(async () => {
  registry = await startFileRegistry({ manifest: manifestFor(root, names.map(entry)) });
});
after(async () => {
  await registry.close();
  rmSync(root, { recursive: true, force: true });
});

test('serves the packed tarball bytes and a packument whose integrity matches them', async () => {
  const meta = await raw('/@zucker-framework%2fcore');
  assert.equal(meta.status, 200);
  const packument = JSON.parse(meta.body.toString());
  assert.deepEqual(packument['dist-tags'], { latest: VERSION });
  assert.deepEqual(Object.keys(packument.versions), [VERSION]);
  const { dist, scripts, devDependencies } = packument.versions[VERSION];
  assert.equal(devDependencies, undefined);
  assert.deepEqual(scripts, { postinstall: 'true' }, 'only install-time lifecycle scripts are kept');
  assert.ok(dist.tarball.startsWith(`http://127.0.0.1:${registry.port}/`), 'tarball URL points back at the local registry');
  const tarball = await raw(new URL(dist.tarball).pathname);
  assert.equal(tarball.status, 200);
  assert.deepEqual(tarball.body, bytes.core);
  assert.equal(`sha512-${createHash('sha512').update(tarball.body).digest('base64')}`, dist.integrity);
  assert.equal(createHash('sha1').update(tarball.body).digest('hex'), dist.shasum);
  assert.equal((await raw('/@zucker-framework/core')).status, 200, 'unencoded scope path is served too');
});

test('refuses packages and tarball names that were not packed, without forwarding them', async () => {
  for (const path of [
    '/@zucker-framework/ai', '/@zucker-framework/core/-/core-9.9.9.tgz', '/@zucker-framework/core/-/other-1.2.3.tgz',
    '/@zucker-framework/crud/-/core-1.2.3.tgz', '/left-pad', '/@other/core',
  ]) assert.equal((await raw(path)).status, 404, path);
  assert.ok(registry.requests.every((r) => r.outcome === 'not-found' || r.outcome === 'served' || r.outcome === 'refused'));
  assert.ok(registry.requests.some((r) => r.path === '/@zucker-framework/ai' && r.outcome === 'not-found'));
});

test('offline mode never proxies: non-framework names are 404 and the log has no proxied entry', async () => {
  const before = registry.requests.length;
  assert.equal((await raw('/lodash')).status, 404);
  assert.equal((await raw('/lodash/-/lodash-4.0.0.tgz')).status, 404);
  assert.deepEqual(registry.requests.slice(before).map((r) => r.outcome), ['not-found', 'not-found']);
});

test('path traversal, encoded separators, NUL bytes and non-GET methods are refused', async () => {
  for (const path of [
    '/@zucker-framework/core/-/../../../../etc/passwd', '/../manifest.json', '/%2e%2e/manifest.json',
    '/@zucker-framework/core/-/..%2f..%2fmanifest.json', '/@zucker-framework/core/-/%2e%2e%5cmanifest.json',
    '/@zucker-framework/core%00', '/%', '/@zucker-framework/core/-/core-1.2.3.tgz/..',
  ]) {
    const res = await raw(path);
    assert.equal(res.status, 404, path);
    assert.ok(!res.body.toString().includes('synthetic tarball'), path);
  }
  for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await raw('/@zucker-framework/core', { method })).status, 404, method);
  assert.equal((await raw('/@zucker-framework/core/-/zucker-framework-core-1.2.3.tgz', { method: 'POST' })).status, 404);
});

test('HEAD returns headers without a body', async () => {
  const res = await raw(tarballPath('@zucker-framework/core', VERSION), { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(Number(res.headers['content-length']), bytes.core.length);
  assert.equal(res.body.length, 0);
});

test('binds 127.0.0.1 only by default', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zf-registry-bind-'));
  const local = await startFileRegistry({ manifest: manifestFor(dir, names.map(entry)) });
  try {
    assert.equal(new URL(local.url).hostname, '127.0.0.1');
    assert.match(local.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    // The listening socket is observable through the OS: loopback only.
    const ss = await new Promise((resolve) => {
      const child = spawn('ss', ['-ltnH', `sport = :${local.port}`]);
      let out = '';
      child.stdout.on('data', (c) => { out += c; });
      child.on('error', () => resolve(null));
      child.on('close', () => resolve(out));
    });
    if (ss !== null) {
      assert.match(ss, /127\.0\.0\.1:/);
      assert.doesNotMatch(ss, /(?:0\.0\.0\.0|\[::\]|\*):\d+/);
    }
  } finally {
    await local.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('proxy mode never forwards @zucker-framework names, and upstream must be https', async () => {
  await assert.rejects(startFileRegistry({ manifest: join(root, 'manifest.json'), upstream: 'http://registry.example.test/' }), /https/);
  // 127.0.0.1 upstream is allowed for tests; nothing listens there, so a forwarded request would be proxy-failed (502).
  const proxy = await startFileRegistry({ manifest: join(root, 'manifest.json'), upstream: 'http://127.0.0.1:9/' });
  try {
    for (const path of ['/@zucker-framework/ai', '/@zucker-framework/core/-/core-9.9.9.tgz', '/@zucker-framework%2fnope']) {
      assert.equal((await raw(path, { port: proxy.port })).status, 404, path);
    }
    assert.ok(proxy.requests.every((r) => r.outcome === 'not-found'), 'no framework request left the machine');
    assert.equal((await raw('/left-pad', { port: proxy.port })).status, 502, 'other names would be forwarded (and fail here)');
    assert.equal(proxy.requests.at(-1).outcome, 'proxy-failed');
  } finally {
    await proxy.close();
  }
});

test('request log file records what was refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zf-registry-log-'));
  const log = join(dir, 'requests.log');
  const logged = await startFileRegistry({ manifest: manifestFor(dir, names.map(entry)), log });
  try {
    await raw('/@zucker-framework/missing', { port: logged.port });
    await raw('/@zucker-framework/core', { port: logged.port });
  } finally {
    await logged.close();
  }
  const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.outcome), ['not-found', 'served']);
  rmSync(dir, { recursive: true, force: true });
});

test('manifest validation rejects foreign scopes, bad versions, path-like tarball names and missing files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zf-registry-manifest-'));
  try {
    const write = (e) => { const file = join(dir, 'manifest.json'); writeFileSync(file, JSON.stringify({ packages: [e] })); return file; };
    const base = entry('core');
    assert.throws(() => loadManifest(write({ ...base, name: 'left-pad' })), /Invalid package name/);
    assert.throws(() => loadManifest(write({ ...base, name: '@other/core' })), /Invalid package name/);
    assert.throws(() => loadManifest(write({ ...base, version: 'latest' })), /Invalid version/);
    assert.throws(() => loadManifest(write({ ...base, file: '../../etc/passwd' })), /file name/);
    assert.throws(() => loadManifest(write({ ...base, file: 'absent.tgz' })), /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseRequestPath classifies registry paths and rejects unsafe ones', () => {
  assert.deepEqual(parseRequestPath('/@zucker-framework%2fcore?write=true'), { kind: 'packument', name: '@zucker-framework/core' });
  assert.deepEqual(parseRequestPath('/@zucker-framework/core/-/core-1.0.0.tgz'), { kind: 'tarball', name: '@zucker-framework/core', file: 'core-1.0.0.tgz' });
  for (const bad of ['/a/b/c', '/..', '/@zucker-framework/core/-/../x.tgz', '/%zz', '/x\\y', '/@Bad/Name']) assert.equal(parseRequestPath(bad), null, bad);
});

test('CLI entry binds loopback, prints its URL and stops on SIGTERM', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zf-registry-cli-'));
  const manifest = manifestFor(dir, names.map(entry));
  const child = spawn(process.execPath, [script, '--manifest', manifest, '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const line = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.stdout.once('data', (c) => resolve(c.toString()));
    });
    const { url, port } = JSON.parse(line);
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal((await raw('/@zucker-framework/crud', { port })).status, 200);
    const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    child.kill('SIGTERM');
    assert.equal(await exited, 0);
  } finally {
    if (child.exitCode === null) child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
