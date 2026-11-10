import { Logger } from '@nestjs/common';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';

export interface HttpActionConfig {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
  /** 重试次数（默认 0 不重试） */
  retryCount?: number;
  /** 重试间隔（毫秒，默认 1000） */
  retryDelay?: number;
  /**
   * Follow HTTP redirects (default false: a redirect fails the action). At most 5 hops; every
   * hop is checked against the destination policy (including DNS resolution with the default
   * policy), and custom headers are dropped when a hop changes origin.
   */
  followRedirects?: boolean;
}

/**
 * Decides whether the action may call `url`. Return false (or throw) to refuse.
 * Called for the initial URL and for every redirect hop.
 */
export type HttpDestinationPolicy = (url: URL) => boolean | Promise<boolean>;

/** Resolves a hostname to all of its addresses (default: `dns.promises.lookup(host, { all: true })`). */
export type HttpHostResolver = (hostname: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;

export interface HttpActionOptions {
  /**
   * Custom destination policy; replaces the default. A custom policy sees the URL only: the
   * built-in DNS check and address pinning are not applied (use an egress proxy if needed).
   */
  destinationPolicy?: HttpDestinationPolicy;
  /** Allow loopback/private/link-local/single-label destinations with the default policy (default false). */
  allowPrivateNetwork?: boolean;
  /** Maximum response body size in bytes (default 1 MiB). */
  maxResponseBytes?: number;
  /** DNS resolver used by the default policy (mainly for tests). */
  resolveHost?: HttpHostResolver;
  /**
   * Custom fetch-compatible transport (e.g. one bound to an egress proxy). It is called with
   * `redirect: 'manual'`. The default policy still resolves and checks the destination first,
   * but cannot pin the connection to the checked address for a custom transport; the built-in
   * transport (`node:http`/`node:https`) connects only to the addresses that passed the check.
   */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Thrown when a destination is refused; never retried. */
class HttpDestinationError extends Error {}

function isPrivateIPv4(ip: string): boolean {
  const [a, b, c] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
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

function isPrivateIPv6(ip: string): boolean {
  const h = ipv6Hextets(ip);
  if (!h) return true; // unparseable: refuse
  const zero = (from: number, to: number) => h.slice(from, to).every((x) => x === 0);
  // ::/96 (unspecified, loopback, IPv4-compatible) and ::ffff:0:0/96 (IPv4-mapped): check the IPv4.
  if (zero(0, 6) || (zero(0, 5) && h[5] === 0xffff)) return isPrivateIPv4(ipv4FromHextets(h[6], h[7]));
  // 64:ff9b::/96 NAT64: check the embedded IPv4; 64:ff9b:1::/48 is local-use NAT64.
  if (h[0] === 0x64 && h[1] === 0xff9b) {
    return zero(2, 6) ? isPrivateIPv4(ipv4FromHextets(h[6], h[7])) : true;
  }
  // 2002::/16 6to4: the IPv4 is in hextets 1-2.
  if (h[0] === 0x2002) return isPrivateIPv4(ipv4FromHextets(h[1], h[2]));
  if (h[0] === 0x2001 && h[1] === 0) return true; // Teredo (embeds an obfuscated IPv4)
  if (h[0] === 0x100 && zero(1, 4)) return true; // 100::/64 discard
  return (
    (h[0] & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (h[0] & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (h[0] & 0xffc0) === 0xfec0 || // fec0::/10 site-local (deprecated)
    (h[0] & 0xff00) === 0xff00 // ff00::/8 multicast
  );
}

/** True for loopback/private/link-local/reserved IP literals. */
function isPrivateIp(address: string): boolean {
  const a = address.replace(/^\[|\]$/g, '').toLowerCase().replace(/%.*$/, '');
  const kind = isIP(a);
  if (kind === 4) return isPrivateIPv4(a);
  if (kind === 6) return isPrivateIPv6(a);
  return true;
}

/** Host as used for policy checks: brackets and trailing dots removed, lower case. */
function normaliseHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
}

function isInternalName(host: string): boolean {
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

const defaultResolveHost: HttpHostResolver = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

interface VettedDestination {
  /** Addresses the connection must use, or undefined when the transport may resolve freely. */
  addresses?: Array<{ address: string; family: number }>;
}

/**
 * Default policy check. Returns the vetted addresses (for pinning) or throws HttpDestinationError.
 */
async function vetDefault(
  url: URL,
  allowPrivateNetwork: boolean,
  resolveHost: HttpHostResolver,
): Promise<VettedDestination> {
  const refuse = () => new HttpDestinationError(`HTTP action destination is not allowed: ${url.origin}`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw refuse();
  if (url.username || url.password) throw refuse();
  if (allowPrivateNetwork) return {};
  const host = normaliseHost(url.hostname);
  if (!host) throw refuse();
  if (isIP(host)) {
    if (isPrivateIp(host)) throw refuse();
    return { addresses: [{ address: host, family: isIP(host) }] };
  }
  if (isInternalName(host)) throw refuse();
  let resolved: ReadonlyArray<{ address: string; family: number }>;
  try {
    resolved = await resolveHost(host);
  } catch (error) {
    throw new Error(`HTTP action could not resolve ${url.hostname}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (resolved.length === 0) throw new Error(`HTTP action could not resolve ${url.hostname}`);
  // Refuse when ANY address is private: the transport could otherwise pick it.
  if (resolved.some((r) => isPrivateIp(r.address))) throw refuse();
  return { addresses: resolved.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 })) };
}

/**
 * Default destination policy: http/https only, no credentials in the URL, no single-label or
 * internal names (`localhost`, `*.local`, `*.internal`, `*.svc`), and every address the host
 * resolves to must be public (loopback, private, link-local, CGNAT, multicast, metadata and the
 * IPv6 equivalents including mapped/compatible/NAT64/6to4 forms are refused). Trailing dots are
 * ignored. `HttpAction` additionally pins the connection to the checked addresses.
 */
export function defaultHttpDestinationPolicy(
  allowPrivateNetwork = false,
  resolveHost: HttpHostResolver = defaultResolveHost,
): HttpDestinationPolicy {
  return async (url) => {
    try {
      await vetDefault(url, allowPrivateNetwork, resolveHost);
      return true;
    } catch (error) {
      if (error instanceof HttpDestinationError) return false;
      throw error;
    }
  };
}

/** Pins a `node:http(s)` connection to pre-checked addresses (no second DNS lookup). */
function pinnedLookup(addresses: Array<{ address: string; family: number }>): LookupFunction {
  return (_hostname, options, callback) => {
    const family = typeof options === 'object' && options ? options.family : undefined;
    const candidates = family === 4 || family === 6 ? addresses.filter((a) => a.family === family) : addresses;
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
 * Built-in transport: `node:http`/`node:https` with the vetted addresses pinned, wrapped in a
 * fetch `Response`. Never follows redirects itself.
 */
function nodeTransport(url: URL, init: RequestInit, vetted: VettedDestination): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const headers: OutgoingHttpHeaders = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const body = typeof init.body === 'string' ? init.body : undefined;
    if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
    const req = send(url, {
      method: init.method,
      headers,
      signal: init.signal ?? undefined,
      ...(vetted.addresses ? { lookup: pinnedLookup(vetted.addresses) } : {}),
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
 * HTTP 动作执行器 — 对齐 jetlinks 的数据推送能力
 *
 * 增强：
 * - 支持重试机制
 * - 模板表达式支持（在 URL、headers、body 中使用 ${variable}）
 * - 响应规范化
 */
export class HttpAction {
  private readonly logger = new Logger(HttpAction.name);
  private readonly customPolicy?: HttpDestinationPolicy;
  private readonly allowPrivateNetwork: boolean;
  private readonly resolveHost: HttpHostResolver;
  private readonly customFetch?: (url: string, init: RequestInit) => Promise<Response>;
  private readonly maxResponseBytes: number;

  constructor(options: HttpActionOptions = {}) {
    this.customPolicy = options.destinationPolicy;
    this.allowPrivateNetwork = options.allowPrivateNetwork ?? false;
    this.resolveHost = options.resolveHost ?? defaultResolveHost;
    this.customFetch = options.fetch;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  async execute(
    config: HttpActionConfig,
    data: Record<string, unknown>,
  ): Promise<unknown> {
    this.validate(config);

    // URL placeholders are percent-encoded so data cannot change the host, path or query structure.
    const url = this.interpolate(config.url, data, encodeURIComponent);
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error('HTTP action URL is invalid after interpolation');
    }
    // Body placeholders are substituted in string leaves (keys and values) after parsing, so
    // quotes in data cannot inject JSON fields.
    const body = config.body
      ? this.interpolateValue(config.body, data)
      : undefined;

    // 对 headers 也做模板插值 (CR/LF stripped)
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (config.headers) {
      for (const [key, value] of Object.entries(config.headers)) {
        headers[key] = this.interpolate(value, data, (v) => v.replace(/[\r\n]/g, ''));
      }
    }

    // Log origin + path only: queries often carry webhook tokens.
    this.logger.log(`HTTP action: ${config.method} ${parsedUrl.origin}${parsedUrl.pathname}`);

    const maxAttempts = (config.retryCount ?? 0) + 1;
    const retryDelay = config.retryDelay ?? 1000;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.doRequest(config, parsedUrl, headers, body);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        // A refused destination is a configuration error: retrying cannot help.
        if (error instanceof HttpDestinationError) break;
        if (attempt < maxAttempts) {
          this.logger.warn(
            `HTTP action attempt ${attempt} failed, retrying in ${retryDelay}ms: ${lastError.message}`,
          );
          await this.delay(retryDelay);
        }
      }
    }

    throw lastError ?? new Error('HTTP action failed');
  }

  /**
   * 验证配置有效性
   */
  validate(config: HttpActionConfig): void {
    if (!config.url || config.url.trim().length === 0) {
      throw new Error('HTTP action URL is required');
    }
    const validMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
    if (!validMethods.includes(config.method)) {
      throw new Error(`Invalid HTTP method: ${config.method}`);
    }
  }

  /** Applies the destination policy to one hop; throws HttpDestinationError when refused. */
  private async vet(url: URL): Promise<VettedDestination> {
    if (this.customPolicy) {
      let allowed = false;
      try {
        allowed = await this.customPolicy(url);
      } catch (error) {
        throw new HttpDestinationError(
          `HTTP action destination is not allowed: ${url.origin} (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      if (!allowed) throw new HttpDestinationError(`HTTP action destination is not allowed: ${url.origin}`);
      return {};
    }
    return vetDefault(url, this.allowPrivateNetwork, this.resolveHost);
  }

  private async doRequest(
    config: HttpActionConfig,
    firstUrl: URL,
    firstHeaders: Record<string, string>,
    payload: unknown,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = config.timeout ?? 30000;
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    let url = firstUrl;
    let method: string = config.method;
    let headers: Record<string, string> = firstHeaders;
    let body: string | undefined = payload ? JSON.stringify(payload) : undefined;

    try {
      for (let hop = 0; ; hop++) {
        const vetted = await this.vet(url);
        const init: RequestInit = { method, headers, body, signal: controller.signal, redirect: 'manual' };
        const response = this.customFetch
          ? await this.customFetch(url.toString(), init)
          : await nodeTransport(url, init, vetted);

        const location = REDIRECT_STATUSES.has(response.status) ? response.headers?.get?.('location') : null;
        if (location) {
          await response.body?.cancel().catch(() => undefined);
          if (!config.followRedirects) {
            throw new Error(`HTTP ${response.status}: redirect not followed (followRedirects is off)`);
          }
          if (hop >= MAX_REDIRECTS) throw new Error(`HTTP action exceeded ${MAX_REDIRECTS} redirects`);
          let next: URL;
          try {
            next = new URL(location, url);
          } catch {
            throw new Error('HTTP action received an invalid redirect location');
          }
          if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
            method = 'GET';
            body = undefined;
          }
          if (next.origin !== url.origin) {
            // Configured headers (tokens, Authorization) are meant for the configured origin only.
            headers = body !== undefined ? { 'Content-Type': 'application/json' } : {};
          } else if (body === undefined) {
            headers = Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'content-type'));
          }
          this.logger.log(`HTTP action redirect ${response.status} -> ${next.origin}${next.pathname}`);
          url = next;
          continue;
        }

        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error(
            `HTTP ${response.status}: ${response.statusText}`,
          );
        }

        const responseData = await this.readLimited(response);
        try {
          return JSON.parse(responseData);
        } catch {
          return responseData;
        }
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async readLimited(response: Response): Promise<string> {
    const limit = this.maxResponseBytes;
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > limit) {
      throw new Error(`HTTP action response exceeds ${limit} bytes`);
    }
    const stream = response.body as ReadableStream<Uint8Array> | null | undefined;
    if (!stream || typeof stream.getReader !== 'function') {
      const text = await response.text();
      if (Buffer.byteLength(text) > limit) throw new Error(`HTTP action response exceeds ${limit} bytes`);
      return text;
    }
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`HTTP action response exceeds ${limit} bytes`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  /**
   * 模板插值 — 对齐 jetlinks TemplateParser / applyValueExpression
   * 支持 ${key} 和嵌套路径 ${a.b.c}
   */
  private interpolate(
    template: string,
    data: Record<string, unknown>,
    escape: (value: string) => string = (v) => v,
  ): string {
    return template.replace(/\$\{([^}]+)}/g, (_, path: string) => {
      const value = this.getNestedValue(data, path.trim());
      return value !== undefined && value !== null ? escape(String(value)) : '';
    });
  }

  /** Interpolates string leaves (and keys) of a JSON-like value. */
  private interpolateValue(value: unknown, data: Record<string, unknown>, depth = 0): unknown {
    if (depth > 64) throw new Error('HTTP action body is nested too deeply');
    if (typeof value === 'string') return this.interpolate(value, data);
    if (Array.isArray(value)) return value.map((v) => this.interpolateValue(v, data, depth + 1));
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        Object.defineProperty(out, this.interpolate(k, data), {
          value: this.interpolateValue(v, data, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }
    return value;
  }

  private getNestedValue(
    data: Record<string, unknown>,
    path: string,
  ): unknown {
    const parts = path.split('.');
    let current: unknown = data;
    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      if (typeof current !== 'object') return undefined;
      if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
