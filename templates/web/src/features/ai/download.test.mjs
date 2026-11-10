import assert from 'node:assert/strict';
import { test } from 'node:test';

const { parseOutputTicket, outputFileName, MAX_OUTPUT_BYTES } = await import('./download.ts');

const origin = 'https://app.example.invalid';
const now = Date.parse('2026-11-10T00:00:00Z');
const future = '2026-11-10T00:05:00Z';

test('refuses cross-origin, userinfo, wrong-path, token-less and malformed tickets', () => {
  const bad = [
    'https://app.example.invalid.evil.example/api/files/x/download?token=t',
    'https://user@evil.example/api/files/x/download?token=t',
    'http://app.example.invalid/api/files/x/download?token=t',
    '/api/files/x/download/extra?token=t',
    '/api/files/../files/x/other?token=t',
    '/api/files//download?token=t',
    '/api/files/a%2Fb/download?token=t',
    '/api/files/x/download?token=',
    '/api/files/' + 'a'.repeat(81) + '/download?token=t',
    'data:text/plain,hi',
    'blob:https://app.example.invalid/1',
    '',
  ];
  for (const url of bad) assert.equal(parseOutputTicket({ url, expiresAt: future }, origin, now), null, url);
  assert.equal(parseOutputTicket({ url: 5, expiresAt: future }, origin, now), null);
  assert.equal(parseOutputTicket({ url: '/api/files/x/download?token=t', expiresAt: 5 }, origin, now), null);
  assert.equal(parseOutputTicket(null, origin, now), null);
});

test('expiry: expired, exactly-now, unparsable are refused; the future is accepted', () => {
  const url = '/api/files/x/download?token=t';
  assert.equal(parseOutputTicket({ url, expiresAt: '2026-11-10T00:00:00Z' }, origin, now), null);
  assert.equal(parseOutputTicket({ url, expiresAt: 'not a date' }, origin, now), null);
  assert.deepEqual(parseOutputTicket({ url, expiresAt: '2026-11-10T00:00:01Z' }, origin, now), { path: '/api/files/x/download', token: 't' });
});

test('only the path and token are returned; extra query/fragment never leak into the request path', () => {
  const parsed = parseOutputTicket({ url: '/api/files/ab-12/download?token=T&next=https://evil.example#frag', expiresAt: future }, origin, now);
  assert.deepEqual(parsed, { path: '/api/files/ab-12/download', token: 'T' });
});

test('output file names are safe and typed by content type', () => {
  assert.equal(outputFileName('image', 'abc-123-DEF', 0, 'image/png'), 'ai-image-abc123DEF-1.png');
  assert.equal(outputFileName('video', 'x', 2, 'video/mp4'), 'ai-video-x-3.mp4');
  assert.equal(outputFileName('audio', 'x', 0, 'audio/mpeg'), 'ai-audio-x-1.mp3');
  assert.equal(outputFileName('image', 'x', 0, 'text/html'), 'ai-image-x-1.bin');
  const name = outputFileName('image', '../../etc/passwd\\..', 0, 'image/jpeg');
  assert.doesNotMatch(name, /[\\/]/);
  assert.match(name, /^ai-image-[A-Za-z0-9]+-1\.jpg$/);
  assert.equal(outputFileName('image', '///', 0, 'image/webp'), 'ai-image-task-1.webp');
  assert.equal(outputFileName('image', 'a'.repeat(40), 0, 'image/png'), `ai-image-${'a'.repeat(12)}-1.png`);
});

test('size cap constant is a positive byte count', () => {
  assert.ok(Number.isInteger(MAX_OUTPUT_BYTES) && MAX_OUTPUT_BYTES > 0);
});
