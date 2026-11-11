import assert from 'node:assert/strict';
import { test } from 'node:test';

const MiB = 1024 * 1024;
const origin = 'https://app.example.invalid';
const clicks = [];
const fetches = [];
globalThis.window = { location: { origin } };
globalThis.document = {
  createElement: () => ({ click() { clicks.push({ href: this.href, download: this.download, rel: this.rel }); }, remove() {} }),
  body: { append() {} },
};
globalThis.fetch = async (...args) => { fetches.push(args); throw new Error('large downloads must not be fetched into memory'); };

const { downloadOutputTicket } = await import('./download.ts');
const ticket = (bytes, url = '/api/files/out-1/download?token=t0k%2Fen') => ({ url, expiresAt: new Date(Date.now() + 60_000).toISOString(), bytes });

test('a large or unknown-size output is a plain navigation: no fetch, no Blob, same-origin path with an encoded token', async () => {
  for (const bytes of [32 * MiB + 1, 600 * MiB, undefined]) {
    clicks.length = 0; fetches.length = 0;
    await downloadOutputTicket(ticket(bytes), 'clip.mp4');
    assert.equal(fetches.length, 0, String(bytes));
    assert.deepEqual(clicks, [{ href: '/api/files/out-1/download?token=t0k%2Fen', download: 'clip.mp4', rel: 'noreferrer' }]);
  }
});

test('a forged large-output ticket (foreign origin, userinfo, wrong path, expired) never navigates', async () => {
  const forged = [
    ticket(600 * MiB, 'https://evil.example/api/files/out-1/download?token=t'),
    ticket(600 * MiB, 'https://user@evil.example/api/files/out-1/download?token=t'),
    ticket(600 * MiB, '/api/files/out-1/other?token=t'),
    ticket(600 * MiB, '/api/files/out-1/download?token='),
    { ...ticket(600 * MiB), expiresAt: '2020-01-01T00:00:00Z' },
  ];
  for (const bad of forged) {
    clicks.length = 0;
    await assert.rejects(downloadOutputTicket(bad, 'clip.mp4'), /Invalid download ticket/);
    assert.equal(clicks.length, 0);
  }
});

test('a small output keeps the verified Blob path and never navigates', async () => {
  clicks.length = 0; fetches.length = 0;
  await assert.rejects(downloadOutputTicket(ticket(1 * MiB), 'a.png')); // the fake fetch refuses: proves the fetch path was taken
  assert.equal(fetches.length, 1);
  assert.equal(clicks.length, 0);
});

test('same-origin userinfo and extra query/fragment never reach the navigated href', async () => {
  clicks.length = 0;
  await downloadOutputTicket(ticket(600 * MiB, 'https://user:pw@app.example.invalid/api/files/out-1/download?token=t&next=//evil.example#frag'), 'x.mp4');
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].href, '/api/files/out-1/download?token=t');
});
