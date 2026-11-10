import { Logger } from '@nestjs/common';
import { isIP } from 'node:net';

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
  /** Follow HTTP redirects (default false: a redirect fails the action, so it cannot bypass the destination policy). */
  followRedirects?: boolean;
}

/**
 * Decides whether the action may call `url`. Return false (or throw) to refuse.
 * Note: the default policy checks the URL only; it does not resolve DNS, so a public hostname
 * that resolves to a private address is not detected — use an egress proxy for that.
 */
export type HttpDestinationPolicy = (url: URL) => boolean | Promise<boolean>;

export interface HttpActionOptions {
  /** Custom destination policy; replaces the default (public http/https destinations only). */
  destinationPolicy?: HttpDestinationPolicy;
  /** Allow loopback/private/link-local destinations with the default policy (default false). */
  allowPrivateNetwork?: boolean;
  /** Maximum response body size in bytes (default 1 MiB). */
  maxResponseBytes?: number;
}

const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateAddress(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  const kind = isIP(h);
  if (kind === 4) return isPrivateIPv4(h);
  if (kind === 6) {
    if (h === '::' || h === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    if (mapped) return isPrivateIPv4(mapped[1]);
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(h)) return true; // mapped, hex form: refuse
    return /^(fc|fd|fe[89ab]|ff)/.test(h);
  }
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal');
}

/** Default destination policy: http/https only, no loopback/private/link-local/metadata addresses. */
export function defaultHttpDestinationPolicy(allowPrivateNetwork = false): HttpDestinationPolicy {
  return (url) => {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (url.username || url.password) return false;
    return allowPrivateNetwork || !isPrivateAddress(url.hostname);
  };
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
  private readonly destinationPolicy: HttpDestinationPolicy;
  private readonly maxResponseBytes: number;

  constructor(options: HttpActionOptions = {}) {
    this.destinationPolicy =
      options.destinationPolicy ?? defaultHttpDestinationPolicy(options.allowPrivateNetwork ?? false);
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
    if (!(await this.destinationPolicy(parsedUrl))) {
      throw new Error(`HTTP action destination is not allowed: ${parsedUrl.origin}`);
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
        return await this.doRequest(config, url, headers, body);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
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

  private async doRequest(
    config: HttpActionConfig,
    url: string,
    headers: Record<string, string>,
    body: unknown,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = config.timeout ?? 30000;
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        method: config.method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        redirect: config.followRedirects ? 'follow' : 'error',
      });

      if (!response.ok) {
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
