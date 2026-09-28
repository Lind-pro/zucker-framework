const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { harness, defer, until } = require('./harness.cjs');

test('cleanup commands still run after capture cancellation', async () => {
  const gate = defer();
  const calls = [];
  const h = harness('fixture', {}, { capture: async (ctx) => {
    gate.resolve();
    await until(async () => (await h.send('STATE')).batch.cancelRequested);
    await assert.rejects(async () => ctx.send('Page.enable'), /Cancelled/);
    await ctx.cleanup('Emulation.clearDeviceMetricsOverride');
  } });
  const send = h.chrome.debugger.sendCommand;
  h.chrome.debugger.sendCommand = (target, method, params, callback) => {
    calls.push(method);
    send(target, method, params, callback);
  };
  h.init();
  await h.send('START', { urls: ['https://fixture.test/cancel'] });
  await gate.promise;
  await h.send('CANCEL');
  await until(async () => !(await h.send('STATE')).batch.busy);
  assert.ok(calls.includes('Emulation.clearDeviceMetricsOverride'));
  assert.equal(h.log.downloads.length, 0);
  assert.equal((await h.send('STATE')).quota.used, 0);
});

test('download deadline cancels and reclaims its blob without settling quota', async () => {
  const h = harness('fixture', {}, { autoComplete: false });
  const downloader = h.api.createDownloader('Synthetic', { deadlineMs: 50, blobLeaseMs: 100, pollMs: 10 });
  await assert.rejects(downloader.downloadViaBlob('eA==', 'text/plain', 'x.txt'), /timed out/);
  assert.equal(h.log.downloads[0].state, 'interrupted');
  assert.deepEqual(h.log.revoked, ['blob:fixture-1']);
});

test('checkpoint persistence failure cancels a created download and revokes blob', async () => {
  const h = harness('fixture', {}, { autoComplete: false });
  const downloader = h.api.createDownloader('Synthetic');
  await assert.rejects(downloader.downloadViaBlob('eA==', 'text/plain', 'x.txt', {
    onCreated: async () => { throw new Error('checkpoint failed'); },
  }), /checkpoint failed/);
  assert.equal(h.log.downloads[0].state, 'interrupted');
  assert.equal(h.log.revoked.length, 1);
});

test('concurrent outputs share one offscreen creation and retain distinct ownership', async () => {
  const h = harness('fixture');
  const gate = defer();
  let creates = 0, blob = 0;
  h.chrome.offscreen.hasDocument = async () => false;
  h.chrome.offscreen.createDocument = async () => { creates++; await gate.promise; };
  const message = h.chrome.runtime.sendMessage;
  h.chrome.runtime.sendMessage = async (msg) => msg.type === 'CREATE_BLOB_URL'
    ? { ok: true, url: `blob:concurrent-${++blob}` } : message(msg);
  const downloader = h.api.createDownloader('Synthetic');
  const tasks = [1, 2].map((n) => downloader.downloadViaBlob('eA==', 'text/plain', `${n}.txt`));
  await until(() => creates === 1);
  gate.resolve();
  await Promise.all(tasks);
  assert.equal(creates, 1);
  assert.deepEqual(h.log.revoked.sort(), ['blob:concurrent-1', 'blob:concurrent-2']);
});

test('licensing timeout also bounds a non-cooperative request port', async () => {
  const h = harness('fixture');
  const license = h.api.createLicensing('fixture', 'Fixture', {
    cacheTtlMs: 10, offlineGraceMs: 20, retryDelayMs: 0, requestTimeoutMs: 50,
    normalizeEntitlement: () => null,
    request: () => new Promise(() => {}),
  });
  await assert.rejects(license.activate('synthetic'), /unreachable/);
  assert.equal(h.store.fixture_license_token, undefined);
});

test('cache/grace timings and grant schema are consumer policy, not fixed Pro constants', async () => {
  const now = Date.now();
  const h = harness('fixture', {
    fixture_license_token: 'synthetic',
    fixture_entitlement: { level: 'team', expiresAt: new Date(now + 100000).toISOString(), checkedAt: now - 1000 },
  });
  let requests = 0;
  const config = {
    cacheTtlMs: 2000, offlineGraceMs: 3000, retryDelayMs: 0, requestTimeoutMs: 50,
    normalizeEntitlement: (value) => value?.level === 'team' ? value : null,
    request: async () => { requests++; throw new Error('synthetic outage'); },
  };
  const license = h.api.createLicensing('fixture', 'Fixture', config);
  assert.equal((await license.getStatus()).state, 'pro');
  assert.equal(requests, 0);
  h.store.fixture_entitlement.checkedAt = now - 2500;
  assert.equal((await license.getStatus()).state, 'pro');
  assert.equal(requests, 1);
  h.store.fixture_entitlement.checkedAt = now - 3500;
  assert.equal((await license.getStatus({ force: true })).state, 'unavailable');
  assert.equal(h.store.fixture_license_token, 'synthetic');
});

test('invalid lifecycle timing policy fails early', () => {
  const h = harness('fixture');
  assert.throws(() => h.api.createLicensing('x', 'x', { requestTimeoutMs: -1 }), /Invalid licensing/);
  assert.throws(() => h.api.createDownloader('x', { deadlineMs: 100, blobLeaseMs: 100 }), /Invalid download/);
});

function offscreen() {
  let listener, pagehide, nextId = 0;
  const timers = new Map(), revoked = [];
  const box = {
    chrome: { runtime: { id: 'fixture', onMessage: { addListener: (fn) => { listener = fn; } } } },
    atob, Blob, Uint8Array,
    URL: { createObjectURL: () => `blob:${++nextId}`, revokeObjectURL: (url) => revoked.push(url) },
    setTimeout: (fn, ms) => { const id = Symbol(); timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    addEventListener: (event, fn) => { if (event === 'pagehide') pagehide = fn; },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets/offscreen.js'), 'utf8'), box);
  return { timers, revoked, close: () => pagehide(), send: (message, sender = { id: 'fixture' }) => {
    let reply;
    listener({ target: 'offscreen', ...message }, sender, (r) => { reply = r; });
    return reply;
  } };
}

test('offscreen leases reclaim abandoned blobs and explicit cleanup is idempotent', () => {
  const o = offscreen();
  const created = o.send({ type: 'CREATE_BLOB_URL', base64: 'eA==', mime: 'text/plain', leaseMs: 123 });
  assert.equal(created.ok, true);
  const timer = [...o.timers.values()][0];
  assert.equal(timer.ms, 123);
  timer.fn();
  o.send({ type: 'REVOKE_BLOB_URL', url: created.url });
  assert.deepEqual(o.revoked, ['blob:1']);
  assert.equal(o.timers.size, 0);
});

test('offscreen rejects foreign senders/invalid leases and pagehide drains ownership', () => {
  const o = offscreen();
  const create = { type: 'CREATE_BLOB_URL', base64: 'eA==', mime: 'text/plain' };
  assert.equal(o.send(create, { id: 'foreign' }), undefined);
  assert.equal(o.send({ ...create, leaseMs: NaN }).ok, false);
  o.send(create); o.send(create);
  o.close();
  assert.deepEqual(o.revoked, ['blob:1', 'blob:2']);
  assert.equal(o.timers.size, 0);
});
