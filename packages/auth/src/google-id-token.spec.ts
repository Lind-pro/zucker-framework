// @vitest-environment node
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GoogleIdTokenError, GoogleIdTokenVerifier } from './google-id-token';

const now = 1_790_000_000_000;
const nonce = 'server-issued-browser-bound-nonce';
const client = 'synthetic-client.apps.googleusercontent.com';
function key(kid: string, modulusLength = 2048) {
  const pair = generateKeyPairSync('rsa', { modulusLength });
  return { privateKey: pair.privateKey, jwk: { ...pair.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}
const first = key('first'), rotated = key('rotated');
const claims = { iss: 'https://accounts.google.com', aud: client, sub: 'google-subject',
  iat: now / 1000 - 30, exp: now / 1000 + 600, nonce, email: 'member@example.test', email_verified: true, name: 'Synthetic member' };
function token(changes: Record<string, unknown> = {}, header: Record<string, unknown> = {}, privateKey: KeyObject = first.privateKey) {
  const encoded = [JSON.stringify({ alg: 'RS256', kid: 'first', ...header }), JSON.stringify({ ...claims, ...changes })]
    .map(value => Buffer.from(value).toString('base64url')).join('.');
  return `${encoded}.${sign('RSA-SHA256', Buffer.from(encoded), privateKey).toString('base64url')}`;
}
const response = (keys = [first.jwk], headers: Record<string, string> = {}) => new Response(JSON.stringify({ keys }), {
  headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600', ...headers },
});
const fixture = () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
  return { fetcher, verifier: new GoogleIdTokenVerifier({ audience: client, now: () => now, fetcher }) };
};

describe('Google One Tap ID-token verification', () => {
  it('verifies the official RS256/JWKS contract and returns identity facts without credentials', async () => {
    const { verifier, fetcher } = fixture();
    const identity = await verifier.verify(token({ hd: 'example.test', picture: 'https://images.example.test/avatar' }), { nonce });
    expect(identity).toEqual({ provider: 'google', subject: 'google-subject', email: 'member@example.test', emailVerified: true,
      displayName: 'Synthetic member', avatarUrl: 'https://images.example.test/avatar', hostedDomain: 'example.test', issuedAt: claims.iat, expiresAt: claims.exp });
    expect(fetcher).toHaveBeenCalledWith('https://www.googleapis.com/oauth2/v3/certs', expect.objectContaining({ method: 'GET', redirect: 'error' }));
    expect(identity).not.toHaveProperty('credential'); expect(identity).not.toHaveProperty('nonce');
    await expect(verifier.verify(token({ iss: 'accounts.google.com' }), { nonce })).resolves.toMatchObject({ subject: claims.sub });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ iss: 'https://attacker.example' }, 'issuer'],
    [{ aud: 'different-client' }, 'audience'],
    [{ aud: [client, 'other'], azp: undefined }, 'audience'],
    [{ aud: client, azp: 'other-client' }, 'audience'],
    [{ exp: now / 1000 }, 'time'],
    [{ exp: 'tomorrow' }, 'time'],
    [{ exp: claims.iat }, 'time'],
    [{ iat: now / 1000 + 1 }, 'time'],
    [{ iat: undefined }, 'time'],
    [{ nbf: now / 1000 + 1 }, 'time'],
    [{ nonce: 'different-browser' }, 'nonce'],
    [{ nonce: undefined }, 'nonce'],
    [{ sub: '' }, 'subject'],
    [{ sub: 'invalid subject' }, 'subject'],
    [{ email: undefined }, 'email'],
    [{ email_verified: false }, 'email_unverified'],
    [{ email_verified: 'true' }, 'email_unverified'],
    [{ email_verified: undefined }, 'email_unverified'],
  ] as const)('rejects invalid signed claims %o', async (changes, reason) => {
    const { verifier } = fixture();
    await expect(verifier.verify(token(changes), { nonce })).rejects.toMatchObject({ reason });
  });

  it('requires a trusted audience and nonce and rejects malformed/unsupported tokens before fetching keys', async () => {
    expect(() => new GoogleIdTokenVerifier({ audience: '' })).toThrow('trusted client IDs');
    const { verifier, fetcher } = fixture();
    for (const credential of ['not-a-jwt', token({}, { alg: 'none' }), token({}, { alg: 'HS256' }), token({}, { crit: ['b64'], b64: false }), `${token()}.extra`]) {
      await expect(verifier.verify(credential, { nonce })).rejects.toBeInstanceOf(GoogleIdTokenError);
    }
    await expect(verifier.verify(token(), { nonce: '' })).rejects.toMatchObject({ reason: 'nonce' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects tampering and does not follow token-supplied key URLs', async () => {
    const { verifier, fetcher } = fixture();
    await expect(verifier.verify(token({}, { jku: 'https://attacker.example/keys' }, rotated.privateKey), { nonce }))
      .rejects.toMatchObject({ reason: 'signature' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('https://www.googleapis.com/oauth2/v3/certs');
  });

  it('supports configured audiences, authorized parties and explicit bounded clock tolerance', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const verifier = new GoogleIdTokenVerifier({ audience: [client, 'second-client'], fetcher, now: () => now, clockToleranceSeconds: 30 });
    await expect(verifier.verify(token({ aud: [client, 'second-client'], azp: client, exp: now / 1000 - 1 }), { nonce }))
      .resolves.toMatchObject({ provider: 'google' });
    expect(() => new GoogleIdTokenVerifier({ audience: client, clockToleranceSeconds: 301 })).toThrow('clock tolerance');
  });

  it('coalesces concurrent key requests without allowing one caller cancellation to cancel others', async () => {
    let release!: (value: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockReturnValue(new Promise<Response>(resolve => { release = resolve; }));
    const verifier = new GoogleIdTokenVerifier({ audience: client, fetcher, now: () => now });
    const controller = new AbortController();
    const cancelled = verifier.verify(token(), { nonce, signal: controller.signal });
    const active = verifier.verify(token(), { nonce });
    const error = new Error('synthetic cancellation'); controller.abort(error);
    await expect(cancelled).rejects.toBe(error); release(response());
    await expect(active).resolves.toMatchObject({ subject: claims.sub }); expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refreshes an unknown kid once for rotation and bounds repeated unknown-kid fetches', async () => {
    let clock = now;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response()).mockResolvedValueOnce(response([rotated.jwk]))
      .mockImplementation(async () => response([first.jwk, rotated.jwk]));
    const verifier = new GoogleIdTokenVerifier({ audience: client, fetcher, now: () => clock });
    await verifier.verify(token(), { nonce });
    await expect(verifier.verify(token({}, { kid: 'rotated' }, rotated.privateKey), { nonce })).resolves.toMatchObject({ provider: 'google' });
    await expect(verifier.verify(token({}, { kid: 'missing-1' }), { nonce })).rejects.toMatchObject({ reason: 'key_not_found' });
    await expect(verifier.verify(token({}, { kid: 'missing-2' }), { nonce })).rejects.toMatchObject({ reason: 'key_not_found' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    clock += 30_001; await verifier.verify(token(), { nonce }); expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('honors max-age and Age, and never accepts an expired cached key on provider failure', async () => {
    let clock = now;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response([first.jwk], { 'cache-control': 'max-age=10', age: '9' }))
      .mockRejectedValue(new Error('provider-private-body'));
    const verifier = new GoogleIdTokenVerifier({ audience: client, fetcher, now: () => clock });
    await verifier.verify(token(), { nonce }); clock += 1000;
    await expect(verifier.verify(token(), { nonce })).rejects.toMatchObject({ reason: 'jwks_unavailable' });
    await expect(verifier.verify(token(), { nonce })).rejects.not.toThrow('provider-private-body');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('honors no-store and the configured cache cap', async () => {
    let clock = now;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response([first.jwk], { 'cache-control': 'no-store' }));
    const verifier = new GoogleIdTokenVerifier({ audience: client, fetcher, now: () => clock });
    await verifier.verify(token(), { nonce }); await verifier.verify(token(), { nonce }); expect(fetcher).toHaveBeenCalledTimes(2);
    const cappedFetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const capped = new GoogleIdTokenVerifier({ audience: client, fetcher: cappedFetcher, now: () => clock, maxCacheAgeSeconds: 1 });
    await capped.verify(token(), { nonce }); clock += 1000; await capped.verify(token(), { nonce }); expect(cappedFetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    () => response([]),
    () => response([first.jwk, first.jwk]),
    () => response([{ ...first.jwk, n: 'invalid!' }]),
    () => response([{ ...first.jwk, kty: 'EC' }]),
    () => new Response('not-json'),
  ])('fails closed on malformed/unusable JWKS without exposing its body', async (makeResponse) => {
    const verifier = new GoogleIdTokenVerifier({ audience: client, now: () => now, fetcher: vi.fn<typeof fetch>().mockResolvedValue(makeResponse()) });
    await expect(verifier.verify(token(), { nonce })).rejects.toMatchObject({ reason: 'invalid_jwks' });
  });

  it('rejects weak RSA keys and enforces a bounded provider timeout', async () => {
    const weak = key('weak', 1024);
    const verifier = new GoogleIdTokenVerifier({ audience: client, now: () => now, fetcher: vi.fn<typeof fetch>().mockResolvedValue(response([weak.jwk])) });
    await expect(verifier.verify(token({}, { kid: 'weak' }, weak.privateKey), { nonce })).rejects.toMatchObject({ reason: 'invalid_jwks' });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('timeout with private context')), { once: true });
    }));
    const timed = new GoogleIdTokenVerifier({ audience: client, now: () => now, fetcher, fetchTimeoutMs: 5 });
    await expect(timed.verify(token(), { nonce })).rejects.toMatchObject({ reason: 'jwks_unavailable' });
  });
});
