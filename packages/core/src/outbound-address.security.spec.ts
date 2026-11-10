import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertPublicOutboundUrl,
  classifyAddress,
  createPublicFetch,
  isInternalHostname,
  isPublicAddress,
  normaliseOutboundHost,
  pinnedFetch,
  resolvePublicAddress,
  OutboundHostResolutionError,
  type HostResolver,
} from './outbound-address';
import { OutboundUrlRejectedError } from './outbound-url-policy';

const dnsOf = (table: Record<string, string[]>): HostResolver => async (host) => {
  const answers = table[host];
  if (!answers) throw new Error('ENOTFOUND');
  return answers.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};

describe('classifyAddress: embedded IPv4 and special IPv6 forms', () => {
  it.each([
    // IPv4-mapped, any spelling
    ['::ffff:10.0.0.1', 'private'],
    ['::ffff:0a00:0001', 'private'],
    ['::FFFF:192.168.1.1', 'private'],
    ['0:0:0:0:0:ffff:7f00:1', 'loopback'],
    ['[::ffff:127.0.0.1]', 'loopback'],
    ['::ffff:169.254.169.254', 'link-local'],
    ['::ffff:100.64.0.1', 'cgnat'],
    ['::ffff:0.0.0.0', 'unspecified'],
    ['::ffff:8.8.8.8', 'public'],
    // IPv4-compatible (deprecated)
    ['::127.0.0.1', 'loopback'],
    ['::10.0.0.1', 'private'],
    // NAT64 well-known and local-use
    ['64:ff9b::7f00:1', 'loopback'],
    ['64:ff9b::169.254.169.254', 'link-local'],
    ['64:ff9b::808:808', 'public'],
    ['64:ff9b:1::1', 'reserved'],
    // 6to4
    ['2002:7f00:1::', 'loopback'],
    ['2002:0a00:0001::1', 'private'],
    ['2002:a9fe:a9fe::1', 'link-local'],
    ['2002:808:808::1', 'public'],
    // Teredo, discard, multicast, site-local
    ['2001::1', 'reserved'],
    ['100::1', 'reserved'],
    ['ff02::1', 'multicast'],
    ['fec0::1', 'site-local'],
    // unspecified / loopback spellings
    ['::', 'unspecified'],
    ['0:0:0:0:0:0:0:0', 'unspecified'],
    ['::1', 'loopback'],
    ['0000:0000:0000:0000:0000:0000:0000:0001', 'loopback'],
    // zone ids and brackets are ignored for classification
    ['fe80::1%eth0', 'link-local'],
    ['[fe80::1%25eth0]', 'link-local'],
    ['::1%lo', 'loopback'],
    ['fe80::1%', 'link-local'],
    // boundaries
    ['172.15.255.255', 'public'],
    ['172.16.0.0', 'private'],
    ['100.63.255.255', 'public'],
    ['100.128.0.1', 'public'],
    ['198.17.0.1', 'public'],
    ['198.18.0.1', 'reserved'],
    ['198.20.0.1', 'public'],
    ['192.0.0.1', 'reserved'],
    ['223.255.255.255', 'public'],
    ['240.0.0.1', 'reserved'],
    ['0.1.2.3', 'unspecified'],
    ['2001:db8::1', 'public'], // documentation space is not special-cased
    ['2a00:1450::1', 'public'],
  ])('%s -> %s', (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  it.each([
    '', ' ', 'localhost', 'example.com', '1.2.3', '1.2.3.4.5', '256.1.1.1', '01.2.3.4x', '0x7f.0.0.1', '2130706433', '::1::', ':::', '12345::1',
    'g::1', '::ffff:1.2.3', '1:2:3:4:5:6:7:8:9', '::ffff:999.1.1.1', 'http://127.0.0.1',
  ])('refuses non-literal or malformed %j as invalid', (address) => {
    expect(classifyAddress(address)).toBe('invalid');
    expect(isPublicAddress(address)).toBe(false);
  });

  it('only "public" is accepted by isPublicAddress', () => {
    for (const a of ['127.0.0.1', '::1', '::', '10.0.0.1', 'fe80::1', 'fd00::1', '224.0.0.1']) expect(isPublicAddress(a)).toBe(false);
    expect(isPublicAddress('93.184.216.34')).toBe(true);
    expect(isPublicAddress('2606:4700::1111')).toBe(true);
  });
});

describe('host normalisation and internal names', () => {
  it('normalises brackets, trailing dots and case', () => {
    expect(normaliseOutboundHost('[::1]')).toBe('::1');
    expect(normaliseOutboundHost('EXAMPLE.com..')).toBe('example.com');
  });
  it.each(['localhost', 'a.localhost', 'printer.local', 'db.internal', 'x.svc', 'x.default.svc.cluster.local', 'redis', 'kubernetes'])(
    '%s is internal',
    (host) => expect(isInternalHostname(host)).toBe(true),
  );
  it.each(['example.com', 'local.example.com', 'internal.example.org'])('%s is not internal', (host) => expect(isInternalHostname(host)).toBe(false));
});

describe('resolvePublicAddress: answer sets', () => {
  const dns = dnsOf({
    'v4v6-mixed.example': ['93.184.216.34', '::ffff:10.0.0.1'],
    'last-private.example': ['93.184.216.34', '2606:2800::1', '169.254.169.254'],
    'first-private.example': ['127.0.0.1', '93.184.216.34'],
    'nat64.example': ['64:ff9b::7f00:1'],
    'sixtofour.example': ['2002:c0a8:0101::1'],
    'zone.example': ['fe80::1%eth0'],
    'garbage.example': ['not-an-ip'],
    'ok.example': ['93.184.216.34', '2606:2800::1'],
  });

  it.each(['v4v6-mixed.example', 'last-private.example', 'first-private.example', 'nat64.example', 'sixtofour.example', 'zone.example', 'garbage.example'])(
    'refuses %s with private-address-not-allowed (any bad answer poisons the set)',
    async (host) => {
      await expect(resolvePublicAddress(host, dns)).rejects.toMatchObject({ name: 'OutboundUrlRejectedError', reason: 'private-address-not-allowed' });
    },
  );

  it('accepts a fully public dual-stack set and keeps its order', async () => {
    expect(await resolvePublicAddress('OK.example.', dns)).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800::1', family: 6 },
    ]);
  });

  it('refuses literal and internal hosts without ever calling the resolver', async () => {
    let calls = 0;
    const counting: HostResolver = async () => { calls++; return [{ address: '93.184.216.34', family: 4 }]; };
    for (const host of ['127.0.0.1', '[::1]', '::ffff:7f00:1', 'localhost', 'localhost.', 'db.internal', 'redis', 'a.svc.cluster.local', '']) {
      await expect(resolvePublicAddress(host, counting), host).rejects.toBeInstanceOf(OutboundUrlRejectedError);
    }
    expect(calls).toBe(0);
  });

  it('a resolver failure is not a policy rejection, and its detail stays in the error', async () => {
    const error = await resolvePublicAddress('nx.example', dns).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutboundHostResolutionError);
    expect(error).not.toBeInstanceOf(OutboundUrlRejectedError);
    const none = await resolvePublicAddress('none.example', async () => undefined as never).catch((e: unknown) => e);
    expect(none).toBeInstanceOf(OutboundHostResolutionError);
  });
});

describe('assertPublicOutboundUrl: URL-level bypass attempts', () => {
  const resolve = dnsOf({ 'cdn.example': ['93.184.216.34'], 'loop.example': ['127.0.0.1'] });
  const reason = (url: string, options = {}) => assertPublicOutboundUrl(url, { resolve, ...options }).then(() => 'accepted', (e: OutboundUrlRejectedError) => e.reason);

  it.each([
    // WHATWG URL canonicalises these to 127.0.0.1 / 10.0.0.1 before the check
    ['https://2130706433/', 'private-address-not-allowed'],
    ['https://0x7f.1/', 'private-address-not-allowed'],
    ['https://0177.0.0.1/', 'private-address-not-allowed'],
    ['https://127.1/', 'private-address-not-allowed'],
    ['https://[::ffff:7f00:1]/', 'private-address-not-allowed'],
    ['https://[::ffff:127.0.0.1]/', 'private-address-not-allowed'],
    ['https://[64:ff9b::a00:1]/', 'private-address-not-allowed'],
    ['https://[2002:7f00:1::]/', 'private-address-not-allowed'],
    ['https://[::]/', 'private-address-not-allowed'],
    ['https://[::1]/', 'private-address-not-allowed'],
    ['https://0.0.0.0/', 'private-address-not-allowed'],
    ['https://localhost./', 'local-host-not-allowed'],
    ['https://LOCALHOST/', 'local-host-not-allowed'],
    ['https://loop.example/', 'private-address-not-allowed'],
    ['https://cdn.example@127.0.0.1/', 'credentials-not-allowed'],
    ['https://cdn.example:pw@cdn.example/', 'credentials-not-allowed'],
    ['file:///etc/passwd', 'protocol-not-allowed'],
    ['ftp://cdn.example/x', 'protocol-not-allowed'],
    ['gopher://cdn.example/x', 'protocol-not-allowed'],
    ['https://cdn.example:444/', 'port-not-allowed'],
    ['https://cdn.example:80/', 'port-not-allowed'],
    ['', 'invalid-url'],
    ['//cdn.example/x', 'invalid-url'],
    ['https://cdn.example/a', 'accepted'],
    ['https://cdn.example:443/a', 'accepted'],
  ])('%s -> %s', async (url, expected) => {
    expect(await reason(url)).toBe(expected);
  });

  it('http and custom ports are opt-in and still resolve-checked', async () => {
    expect(await reason('http://cdn.example/a')).toBe('protocol-not-allowed');
    expect(await reason('http://cdn.example/a', { allowedProtocols: ['http:'] })).toBe('accepted');
    expect(await reason('http://cdn.example:8080/a', { allowedProtocols: ['http:'] })).toBe('port-not-allowed');
    expect(await reason('http://cdn.example:8080/a', { allowedProtocols: ['http:'], allowedPorts: [8080] })).toBe('accepted');
    expect(await reason('http://loop.example:8080/a', { allowedProtocols: ['http:'], allowedPorts: [8080] })).toBe('private-address-not-allowed');
  });

  it('does not mutate a URL object passed in', async () => {
    const input = new URL('https://cdn.example/a?x=1#h');
    const { url } = await assertPublicOutboundUrl(input, { resolve });
    expect(url).not.toBe(input); expect(url.href).toBe(input.href);
  });
});

describe('pinnedFetch / createPublicFetch transport', () => {
  let server: Server, port: number;
  const seen: Array<{ host?: string; method?: string; body: string }> = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({ host: req.headers.host, method: req.method, body: Buffer.concat(chunks).toString() });
        if (req.url === '/redirect') { res.writeHead(302, { location: 'http://127.0.0.1:1/secret' }); res.end(); return; }
        if (req.url === '/empty') { res.writeHead(204); res.end(); return; }
        res.writeHead(200, { 'content-type': 'text/plain', 'x-multi': 'a' }); res.end('pinned-ok');
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => { await new Promise((done) => server.close(done)); });

  it('connects to the vetted address, never resolving the hostname (DNS rebinding)', async () => {
    // pinned.invalid cannot resolve; success proves the pinned lookup was used.
    const res = await pinnedFetch(new URL(`http://pinned.invalid:${port}/x`), { method: 'POST', body: 'payload', headers: { 'x-a': '1' } }, [{ address: '127.0.0.1', family: 4 }]);
    expect(res.status).toBe(200); expect(await res.text()).toBe('pinned-ok');
    expect(seen.at(-1)).toEqual({ host: `pinned.invalid:${port}`, method: 'POST', body: 'payload' });
  });

  it('never follows redirects and handles empty bodies', async () => {
    const redirect = await pinnedFetch(new URL(`http://pinned.invalid:${port}/redirect`), { redirect: 'follow' }, [{ address: '127.0.0.1', family: 4 }]);
    expect(redirect.status).toBe(302); expect(redirect.headers.get('location')).toBe('http://127.0.0.1:1/secret');
    const empty = await pinnedFetch(new URL(`http://pinned.invalid:${port}/empty`), {}, [{ address: '127.0.0.1', family: 4 }]);
    expect(empty.status).toBe(204); expect(empty.body).toBeNull();
  });

  it('rejects unsupported body types and an aborted signal', async () => {
    await expect(pinnedFetch(new URL(`http://pinned.invalid:${port}/`), { method: 'POST', body: new URLSearchParams({ a: '1' }) }, [{ address: '127.0.0.1', family: 4 }])).rejects.toBeInstanceOf(TypeError);
    await expect(pinnedFetch(new URL(`http://pinned.invalid:${port}/`), { signal: AbortSignal.abort() }, [{ address: '127.0.0.1', family: 4 }])).rejects.toBeDefined();
  });

  it('createPublicFetch refuses private answers before any connection is made', async () => {
    const before = seen.length;
    const fetchPublic = createPublicFetch({ allowedProtocols: ['http:'], allowedPorts: [port], resolve: dnsOf({ 'evil.example': ['127.0.0.1'], 'mixed.example': ['93.184.216.34', '127.0.0.1'] }) });
    await expect(fetchPublic(`http://evil.example:${port}/x`)).rejects.toMatchObject({ reason: 'private-address-not-allowed' });
    await expect(fetchPublic(`http://mixed.example:${port}/x`)).rejects.toMatchObject({ reason: 'private-address-not-allowed' });
    await expect(fetchPublic(`http://127.0.0.1:${port}/x`)).rejects.toMatchObject({ reason: 'private-address-not-allowed' });
    expect(seen.length).toBe(before);
  });
});
