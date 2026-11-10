import { Inject, Injectable, Optional, type NestMiddleware } from '@nestjs/common';
import { getCorrelationId } from './correlation-id';
import { AccessLogService, type AccessLogCompletionResponse } from './persistent-logs';
import {
  RejectedLogRateLimiter,
  suppressedRejectionsLog,
  type RejectedLogRateLimitOptions,
} from './rejected-log-limiter';
import { PiiFilter } from './pii-filter';

/** Query parameters that carry one-time credentials on auth callbacks / magic links. */
const DETAIL_URL_SENSITIVE_PARAMETERS = ['code', 'state', 'otp', 'captcha', 'ticket'];
const urlFilter = new PiiFilter();

export interface HttpRequestObservation {
  method: string;
  /** Matched route template, or "unknown". Never the concrete URL/query. */
  route: string;
  statusCode: number;
  durationMs: number;
  requestTime: Date;
  requestId?: string;
  userId?: string;
  /** Available only with explicit retainClientIp configuration, never a metric label. */
  ip?: string;
  outcome: 'finished' | 'aborted';
}

export interface HttpRequestObservationOptions {
  /** Return true only after the unsampled observation has been durably accepted. */
  onComplete(observation: HttpRequestObservation): boolean | Promise<boolean>;
  skipPaths?: readonly string[];
  skipPrefixes?: readonly string[];
  /** Bounded acknowledgement wait after completion; defaults to 2000 ms. */
  acknowledgementTimeoutMs?: number;
  /** Retain a detail for unannotated slow responses. Requires persistence. */
  slowRequestMs?: number;
  retainClientIp?: boolean;
  /**
   * Bounds persisted access-log details for rejected/slow responses per status + client and in
   * total per window (defaults: 20 per status and client, 300 per status, 1200 non-5xx, 300 5xx,
   * 60 s). Slow-request details count against the same budgets as rejected ones. Dropped details
   * are summarised in one `http:suppressed` row per closed window. Metrics via onComplete are
   * never sampled. `false` persists every detail (previous behaviour).
   */
  detailRateLimit?: RejectedLogRateLimitOptions | false;
}

export const HTTP_REQUEST_OBSERVATION_OPTIONS = Symbol('HTTP_REQUEST_OBSERVATION_OPTIONS');
// Request-local coordination; not global mutable state or serialized log fields.
export const HTTP_COMPLETION_OBSERVATION = Symbol('HTTP_COMPLETION_OBSERVATION');
export const HTTP_COMPLETION_RESPONSE = Symbol('HTTP_COMPLETION_RESPONSE');
export const HTTP_ACCESS_CAPTURED = Symbol('HTTP_ACCESS_CAPTURED');

export interface ObservedHttpRequest {
  [HTTP_COMPLETION_OBSERVATION]?: Promise<boolean>;
  [HTTP_COMPLETION_RESPONSE]?: Promise<AccessLogCompletionResponse>;
  [HTTP_ACCESS_CAPTURED]?: boolean;
}

interface RequestData extends ObservedHttpRequest {
  method: string;
  path: string;
  url?: string;
  originalUrl?: string;
  ip?: string;
  socket?: { remoteAddress?: string };
  headers?: Record<string, string | string[] | undefined>;
  route?: { path?: unknown };
  user?: { id?: string };
}
interface ResponseData {
  statusCode: number;
  on(event: 'finish' | 'close', listener: () => void): unknown;
  removeListener?(event: 'finish' | 'close', listener: () => void): unknown;
}

/** Observes once at HTTP completion, including guard failures, 404s and streaming responses. */
@Injectable()
export class HttpRequestObservationMiddleware implements NestMiddleware {
  private readonly limiter?: RejectedLogRateLimiter;

  constructor(
    @Inject(HTTP_REQUEST_OBSERVATION_OPTIONS)
    private readonly options: HttpRequestObservationOptions,
    @Optional() @Inject(AccessLogService) private readonly logs?: AccessLogService,
  ) {
    this.limiter = options.detailRateLimit === false
      ? undefined
      : new RejectedLogRateLimiter(options.detailRateLimit);
  }

  use(request: RequestData, response: ResponseData, next: () => void): void {
    if (
      this.options.skipPaths?.includes(request.path) ||
      this.options.skipPrefixes?.some((prefix) => request.path.startsWith(prefix))
    ) {
      next();
      return;
    }
    const startedAt = Date.now();
    const requestId = getCorrelationId();
    let acknowledge: (persisted: boolean) => void = () => {};
    request[HTTP_COMPLETION_OBSERVATION] = new Promise<boolean>((resolve) => {
      acknowledge = resolve;
    });
    let completeResponse: (response: AccessLogCompletionResponse) => void = () => {};
    request[HTTP_COMPLETION_RESPONSE] = new Promise<AccessLogCompletionResponse>((resolve) => {
      completeResponse = resolve;
    });
    let completed = false;
    const complete = (outcome: HttpRequestObservation['outcome']) => {
      if (completed) return;
      completed = true;
      response.removeListener?.('finish', onFinish);
      response.removeListener?.('close', onClose);
      const route = request.route?.path;
      const observation: HttpRequestObservation = {
        method: request.method,
        route: typeof route === 'string' && route.startsWith('/') && !/[?#]/.test(route)
          ? route
          : 'unknown',
        statusCode: outcome === 'aborted' ? 499 : response.statusCode,
        durationMs: Math.max(0, Date.now() - startedAt),
        requestTime: new Date(startedAt),
        requestId,
        userId: request.user?.id,
        ip: this.options.retainClientIp ? request.ip || request.socket?.remoteAddress : undefined,
        outcome,
      };
      completeResponse({
        statusCode: observation.statusCode,
        responseTime: observation.durationMs,
        requestTime: observation.requestTime,
        requestId,
      });
      const configuredTimeout = this.options.acknowledgementTimeoutMs;
      const timeoutMs = configuredTimeout !== undefined && Number.isFinite(configuredTimeout)
        && configuredTimeout > 0 ? configuredTimeout : 2000;
      const timeout = setTimeout(() => acknowledge(false), timeoutMs);
      timeout.unref?.();
      // Both synchronous failures and rejected promises conservatively disable sampling.
      void Promise.resolve()
        .then(() => this.options.onComplete(observation))
        .then((persisted) => acknowledge(persisted === true), () => acknowledge(false))
        .finally(() => clearTimeout(timeout));
      const wantsDetail = this.logs && !request[HTTP_ACCESS_CAPTURED] && (
        observation.statusCode >= 400 ||
        (this.options.slowRequestMs !== undefined && observation.durationMs >= this.options.slowRequestMs)
      );
      const allowed = !wantsDetail || !this.limiter ||
        this.limiter.allow(observation.statusCode, request.ip || request.socket?.remoteAddress);
      const suppressed = this.logs ? this.limiter?.drainSuppressed() : undefined;
      if (suppressed && this.logs) void this.logs.log(suppressedRejectionsLog(suppressed)).catch(() => {});
      if (!allowed) {
        // Suppressed by the rate limit: also stop later rejected-request writers for this request.
        request[HTTP_ACCESS_CAPTURED] = true;
      } else if (this.logs && wantsDetail) {
        request[HTTP_ACCESS_CAPTURED] = true;
        const userAgent = request.headers?.['user-agent'];
        void this.logs.log({
          action: `http:${observation.statusCode}`,
          describe: `${request.method} ${observation.route}`,
          module: 'http',
          userId: observation.userId,
          requestUrl: urlFilter.sanitizeUrl(
            request.originalUrl || request.url || request.path,
            DETAIL_URL_SENSITIVE_PARAMETERS,
          ),
          method: request.method,
          ip: observation.ip,
          userAgent: Array.isArray(userAgent) ? userAgent[0] : userAgent,
          requestTime: observation.requestTime,
          responseTime: observation.durationMs,
          statusCode: observation.statusCode,
          requestId,
          exception: observation.statusCode >= 400 ? `HTTP ${observation.statusCode}` : undefined,
        }, {
          completionObservation: request[HTTP_COMPLETION_OBSERVATION],
          completionResponse: request[HTTP_COMPLETION_RESPONSE],
        }).catch(() => {});
      }
    };
    const onFinish = () => complete('finished');
    const onClose = () => complete('aborted');
    response.on('finish', onFinish);
    response.on('close', onClose);
    next();
  }
}
