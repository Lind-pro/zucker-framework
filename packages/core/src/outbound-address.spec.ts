import { describe, expect, it } from 'vitest';
import {
  assertPublicOutboundUrl,
  classifyAddress,
  createPinnedLookup,
  createPublicFetch,
  OutboundHostResolutionError,
  resolvePublicAddress,
  type HostResolver,
} from './outbound-address';
import { OutboundUrlRejectedError } from './outbound-url-policy';

const fakeDns = (table: Record<string, string[]>): HostResolver => async (host) => {
  const answers = table[host];
  if (!answers) throw new Error('ENOTFOUND');
  return answers.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};

describe('classifyAddress', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'link-local'],
    ['100.64.0.1', 'cgnat'],
    ['0.0.0.0', 'unspecified'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'reserved'],
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fc00::1', 'unique-local'],
    ['fd12:3456::1', 'unique-local'],
    ['fe80::1', 'link-local'],
    ['[fe80::1%eth0]', 'link-local'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:a9fe:a9fe', 'link-local'],
    ['64:ff9b::a00:1', 'private'],
    ['2002:c0a8:0101::1', 'private'],
    ['8.8.8.8', 'public'],
    ['172.32.0.1', 'public'],
    ['2606:4700::1111', 'public'],
    ['example.com', 'invalid'],
  ])('%s -> %s', (ip, expected) => {
    expect(classifyAddress(ip)).toBe(expected);
  });
});

describe('resolvePublicAddress', () => {
  const dns = fakeDns({
    'public.example': ['93.184.216.34', '2606:2800::1'],
    'private.example': ['10.0.0.5'],
    'mixed.example': ['93.184.216.34', '127.0.0.1'],
    'empty.example': [],
  });

  it('returns every vetted answer', async () => {
    await expect(resolvePublicAddress('public.example.', dns)).resolves.toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800::1', family: 6 },
    ]);
  });

  it.each(['private.example', 'mixed.example', 'localhost', 'redis', 'api.internal', '127.0.0.1', '[::1]'])(
    'refuses %s',
    async (host) => {
      await expect(resolvePublicAddress(host, dns)).rejects.toBeInstanceOf(OutboundUrlRejectedError);
    },
  );

  it('reports lookup failures and empty answers as resolution errors', async () => {
    await expect(resolvePublicAddress('missing.example', dns)).rejects.toBeInstanceOf(OutboundHostResolutionError);
    await expect(resolvePublicAddress('empty.example', dns)).rejects.toBeInstanceOf(OutboundHostResolutionError);
  });
});

describe('assertPublicOutboundUrl', () => {
  const resolve = fakeDns({ 'cdn.example': ['93.184.216.34'], 'rebind.example': ['192.168.0.10'] });

  it('accepts https to a public host and returns pinned addresses', async () => {
    const result = await assertPublicOutboundUrl('https://cdn.example/a.png', { resolve });
    expect(result.url.href).toBe('https://cdn.example/a.png');
    expect(result.addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it.each([
    ['http://cdn.example/a', 'protocol-not-allowed'],
    ['https://u:p@cdn.example/a', 'credentials-not-allowed'],
    ['https://cdn.example:8443/a', 'port-not-allowed'],
    ['https://rebind.example/a', 'private-address-not-allowed'],
    ['https://169.254.169.254/latest', 'private-address-not-allowed'],
    ['not a url', 'invalid-url'],
  ])('rejects %s (%s)', async (url, reason) => {
    await expect(assertPublicOutboundUrl(url, { resolve })).rejects.toMatchObject({ reason });
  });

  it('createPublicFetch refuses before connecting', async () => {
    const publicFetch = createPublicFetch({ resolve });
    await expect(publicFetch('https://rebind.example/x')).rejects.toBeInstanceOf(OutboundUrlRejectedError);
  });
});

describe('createPinnedLookup', () => {
  const lookup = createPinnedLookup([
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800::1', family: 6 },
  ]);
  const call = (options: object) =>
    new Promise<unknown[]>((done) => lookup('ignored.example', options as never, (...args: unknown[]) => done(args)));

  it('answers only with the vetted addresses, by family', async () => {
    expect(await call({})).toEqual([null, '93.184.216.34', 4]);
    expect(await call({ family: 6 })).toEqual([null, '2606:2800::1', 6]);
    expect((await call({ all: true }))[1]).toHaveLength(2);
  });

  it('fails when no vetted address has the requested family', async () => {
    const v4only = createPinnedLookup([{ address: '93.184.216.34', family: 4 }]);
    const [error] = await new Promise<unknown[]>((done) =>
      v4only('x', { family: 6 } as never, (...args: unknown[]) => done(args)),
    );
    expect(error).toMatchObject({ code: 'ENOTFOUND' });
  });
});
