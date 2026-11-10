import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { OutboundUrlRejectedError } from './outbound-url-policy';

/**
 * Single implementation of outbound address vetting for the framework (SSRF protection):
 * address classification, hostname resolution where every answer must be public, and a
 * `node:http(s)` lookup/transport pinned to the vetted answers so the connection cannot be
 * re-resolved to a different (private) address between check and connect (DNS rebinding).
 */

/** Category of an IP address. Everything except `public` is refused for outbound calls. */
export type AddressClass =
  | 'public'
  | 'unspecified'
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'cgnat'
  | 'multicast'
  | 'reserved'
  | 'unique-local'
  | 'site-local'
  | 'invalid';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Resolves a hostname to all of its addresses (default: `dns.promises.lookup(host, { all: true, verbatim: true })`). */
export type HostResolver = (hostname: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;

export const defaultHostResolver: HostResolver = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/**
 * The hostname could not be resolved (lookup error or empty answer). Distinct from
 * `OutboundUrlRejectedError` because it may be transient and callers may retry it.
 */
export class OutboundHostResolutionError extends Error {
  constructor(
    readonly hostname: string,
    /** Underlying resolver message; undefined when the answer set was empty. */
    readonly detail?: string,
  ) {
    super(detail === undefined ? `Could not resolve ${hostname}` : `Could not resolve ${hostname}: ${detail}`);
    this.name = 'OutboundHostResolutionError';
  }
}

function classifyIPv4(ip: string): AddressClass {
  const [a, b, c] = ip.split('.').map(Number);
  if (a === 0) return 'unspecified'; // 0.0.0.0/8 "this network"
  if (a === 10) return 'private';
  if (a === 127) return 'loopback';
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
  if (a === 169 && b === 254) return 'link-local'; // includes 169.254.169.254 cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 0 && c === 0) return 'reserved'; // IETF protocol assignments
  if (a === 192 && b === 168) return 'private';
  if (a === 198 && (b === 18 || b === 19)) return 'reserved'; // benchmarking
  if (a >= 224 && a <= 239) return 'multicast';
  if (a >= 240) return 'reserved'; // includes broadcast
  return 'public';
}

/** Expands an IPv6 literal (optionally with an embedded dotted IPv4 tail) into 8 hextets. */
function ipv6Hextets(ip: string): number[] | undefined {
  let text = ip;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [p0, p1, p2, p3] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((p0 << 8) | p1).toString(16)}:${((p2 << 8) | p3).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const parse = (part: string) => (part ? part.split(':').map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN)) : []);
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const fill = 8 - head.length - rest.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return undefined;
  const out = [...head, ...new Array<number>(fill).fill(0), ...rest];
  return out.every((h) => Number.isInteger(h)) ? out : undefined;
}

function ipv4FromHextets(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

function classifyIPv6(ip: string): AddressClass {
  const h = ipv6Hextets(ip);
  if (!h) return 'invalid'; // unparseable: refuse
  const zero = (from: number, to: number) => h.slice(from, to).every((x) => x === 0);
  if (zero(0, 7) && h[7] === 1) return 'loopback'; // ::1
  if (zero(0, 8)) return 'unspecified'; // ::
  // ::/96 (IPv4-compatible) and ::ffff:0:0/96 (IPv4-mapped): classify the IPv4.
  if (zero(0, 6) || (zero(0, 5) && h[5] === 0xffff)) return classifyIPv4(ipv4FromHextets(h[6], h[7]));
  // 64:ff9b::/96 NAT64: classify the embedded IPv4; 64:ff9b:1::/48 is local-use NAT64.
  if (h[0] === 0x64 && h[1] === 0xff9b) {
    return zero(2, 6) ? classifyIPv4(ipv4FromHextets(h[6], h[7])) : 'reserved';
  }
  // 2002::/16 6to4: the IPv4 is in hextets 1-2.
  if (h[0] === 0x2002) return classifyIPv4(ipv4FromHextets(h[1], h[2]));
  if (h[0] === 0x2001 && h[1] === 0) return 'reserved'; // Teredo (embeds an obfuscated IPv4)
  if (h[0] === 0x100 && zero(1, 4)) return 'reserved'; // 100::/64 discard
  if ((h[0] & 0xfe00) === 0xfc00) return 'unique-local'; // fc00::/7
  if ((h[0] & 0xffc0) === 0xfe80) return 'link-local'; // fe80::/10
  if ((h[0] & 0xffc0) === 0xfec0) return 'site-local'; // fec0::/10 (deprecated)
  if ((h[0] & 0xff00) === 0xff00) return 'multicast'; // ff00::/8
  return 'public';
}

/**
 * Classifies an IP literal. Brackets and an IPv6 zone (`%eth0`) are ignored; anything that is
 * not an IP literal is `invalid`. Embedded IPv4 forms (mapped, compatible, NAT64, 6to4) are
 * classified by the IPv4 they carry.
 */
export function classifyAddress(address: string): AddressClass {
  const a = address.replace(/^\[|\]$/g, '').toLowerCase().replace(/%.*$/, '');
  const kind = isIP(a);
  if (kind === 4) return classifyIPv4(a);
  if (kind === 6) return classifyIPv6(a);
  return 'invalid';
}

export function isPublicAddress(address: string): boolean {
  return classifyAddress(address) === 'public';
}

/** Host as used for policy checks: brackets and trailing dots removed, lower case. */
export function normaliseOutboundHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
}

/** Names that resolve inside the deployment rather than on the public internet. */
export function isInternalHostname(host: string): boolean {
  return (
    !host.includes('.') || // single-label names (e.g. `redis`, `kubernetes`) resolve through search domains
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.svc') ||
    host.includes('.svc.cluster.')
  );
}

/**
 * Resolves `hostname` and returns the addresses a connection may use. IP literals are checked
 * directly; internal names are refused without a lookup. Refuses (OutboundUrlRejectedError) when
 * ANY answer is non-public, since a transport could otherwise pick it. Lookup failures and empty
 * answers throw OutboundHostResolutionError.
 */
export async function resolvePublicAddress(
  hostname: string,
  resolve: HostResolver = defaultHostResolver,
): Promise<ResolvedAddress[]> {
  const host = normaliseOutboundHost(hostname);
  if (!host) throw new OutboundUrlRejectedError('host-not-allowed', 'Outbound host is empty');
  const literal = isIP(host);
  if (literal) {
    if (!isPublicAddress(host)) {
      throw new OutboundUrlRejectedError('private-address-not-allowed', 'Outbound address is not public');
    }
    return [{ address: host, family: literal === 6 ? 6 : 4 }];
  }
  if (isInternalHostname(host)) {
    throw new OutboundUrlRejectedError('local-host-not-allowed', 'Internal outbound host names are not allowed');
  }
  let answers: ReadonlyArray<{ address: string; family: number }>;
  try {
    answers = await resolve(host);
  } catch (error) {
    throw new OutboundHostResolutionError(hostname, error instanceof Error ? error.message : String(error));
  }
  if (!answers || answers.length === 0) throw new OutboundHostResolutionError(hostname);
  if (answers.some((answer) => !isPublicAddress(answer.address))) {
    throw new OutboundUrlRejectedError('private-address-not-allowed', 'Outbound host resolves to a non-public address');
  }
  return answers.map((answer) => ({ address: answer.address, family: answer.family === 6 ? 6 : 4 }));
}

export interface PublicOutboundUrlOptions {
  /** Default `['https:']`. */
  allowedProtocols?: readonly ('https:' | 'http:')[];
  /** Default: the standard port of each allowed protocol. */
  allowedPorts?: readonly number[];
  /** Resolver (inject a fake in tests). */
  resolve?: HostResolver;
}

export interface PublicOutboundDestination {
  url: URL;
  /** Vetted addresses; pass them to `createPinnedLookup` / `pinnedFetch`. */
  addresses: ResolvedAddress[];
}

/**
 * For callers without a host allow-list (e.g. re-hosting AI provider output): the URL must use an
 * allowed protocol and port, carry no credentials, and its host must resolve only to public
 * addresses. Connect with the returned addresses (pinnedFetch) and do not follow redirects
 * without vetting each hop again.
 */
export async function assertPublicOutboundUrl(
  input: string | URL,
  options: PublicOutboundUrlOptions = {},
): Promise<PublicOutboundDestination> {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(input);
  } catch {
    throw new OutboundUrlRejectedError('invalid-url', 'Outbound URL is invalid');
  }
  const protocols = options.allowedProtocols ?? ['https:'];
  if (!protocols.includes(url.protocol as 'https:' | 'http:')) {
    throw new OutboundUrlRejectedError('protocol-not-allowed', `Outbound URL protocol is not allowed: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new OutboundUrlRejectedError('credentials-not-allowed', 'Outbound URL credentials are not allowed');
  }
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const ports = options.allowedPorts ?? protocols.map((protocol) => (protocol === 'https:' ? 443 : 80));
  if (!ports.includes(port)) {
    throw new OutboundUrlRejectedError('port-not-allowed', `Outbound URL port is not allowed: ${port}`);
  }
  const addresses = await resolvePublicAddress(url.hostname, options.resolve);
  return { url, addresses };
}

/** A `node:net` lookup that answers only with pre-checked addresses (no second DNS lookup). */
export function createPinnedLookup(addresses: ReadonlyArray<ResolvedAddress>): LookupFunction {
  return (_hostname, options, callback) => {
    const family = typeof options === 'object' && options ? options.family : undefined;
    const candidates = family === 4 || family === 6 ? addresses.filter((a) => a.family === family) : [...addresses];
    if (candidates.length === 0) {
      callback(Object.assign(new Error('No checked address for the requested family'), { code: 'ENOTFOUND' }), '', 4);
      return;
    }
    if (typeof options === 'object' && options && options.all) {
      (callback as unknown as (err: null, addrs: typeof candidates) => void)(null, candidates);
      return;
    }
    callback(null, candidates[0].address, candidates[0].family);
  };
}

/**
 * `node:http`/`node:https` request wrapped in a fetch `Response`. With `addresses`, the connection
 * uses only those (pinned); without, the platform resolves normally. Never follows redirects
 * (`init.redirect` is ignored: a 3xx is returned as is). Bodies: string, Uint8Array or none.
 */
export function pinnedFetch(url: URL, init: RequestInit, addresses?: ReadonlyArray<ResolvedAddress>): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    let body: string | Uint8Array | undefined;
    if (typeof init.body === 'string' || init.body instanceof Uint8Array) body = init.body;
    else if (init.body !== undefined && init.body !== null) {
      reject(new TypeError('pinnedFetch supports string or Uint8Array bodies only'));
      return;
    }
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const headers: OutgoingHttpHeaders = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
    const req = send(url, {
      method: init.method,
      headers,
      signal: init.signal ?? undefined,
      ...(addresses ? { lookup: createPinnedLookup(addresses) } : {}),
    });
    req.on('error', reject);
    req.on('response', (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (Array.isArray(value)) value.forEach((v) => responseHeaders.append(key, v));
        else if (value !== undefined) responseHeaders.set(key, value);
      }
      const nullBody = status === 204 || status === 205 || status === 304 || init.method === 'HEAD';
      if (nullBody) res.resume();
      try {
        resolve(
          new Response(nullBody ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>), {
            status,
            statusText: res.statusMessage ?? '',
            headers: responseHeaders,
          }),
        );
      } catch (error) {
        res.destroy();
        reject(error);
      }
    });
    req.end(body);
  });
}

/**
 * A fetch-compatible function that vets every call with `assertPublicOutboundUrl` and connects
 * only to the vetted addresses. Redirects are never followed. Rejections are
 * OutboundUrlRejectedError / OutboundHostResolutionError.
 */
export function createPublicFetch(
  options: PublicOutboundUrlOptions = {},
): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url, init = {}) => {
    const destination = await assertPublicOutboundUrl(url, options);
    return pinnedFetch(destination.url, init, destination.addresses);
  };
}
