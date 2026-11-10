import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import { AccessLogService } from './persistent-logs';
import {
  HTTP_ACCESS_CAPTURED,
  HTTP_COMPLETION_OBSERVATION,
  HTTP_COMPLETION_RESPONSE,
  type ObservedHttpRequest,
} from './http-request-observation.middleware';
import { getCorrelationId } from './correlation-id';
import {
  RejectedLogRateLimiter,
  suppressedRejectionsLog,
  type RejectedLogRateLimitOptions,
} from './rejected-log-limiter';
import { PiiFilter } from './pii-filter';

/** Query parameters that carry one-time credentials on auth callbacks / magic links. */
export const REJECTED_URL_SENSITIVE_PARAMETERS = ['code', 'state', 'otp', 'captcha', 'ticket'] as const;
const urlFilter = new PiiFilter();

export interface RejectedRequestLogOptions {
  skipPaths?: readonly string[];
  skipPrefixes?: readonly string[];
  retainClientIp?: boolean;
  /**
   * Bounds persisted rejections per status + client and in total per window (defaults:
   * 20 per status and client, 300 per status, 1200 non-5xx in total, 300 5xx, 60 s). Dropped rows
   * are summarised in one `http:suppressed` row per closed window. `false` persists every
   * rejection (previous behaviour).
   */
  rateLimit?: RejectedLogRateLimitOptions | false;
}
export const REJECTED_REQUEST_LOG_OPTIONS = Symbol('REJECTED_REQUEST_LOG_OPTIONS');
interface RequestData extends ObservedHttpRequest {
  path: string;
  method: string;
  url: string;
  originalUrl?: string;
  ip?: string;
  socket?: { remoteAddress?: string };
  headers: Record<string, string | string[] | undefined>;
  user?: { id?: string; username?: string; email?: string };
}
interface ResponseData {
  statusCode: number;
  on(event: 'finish', listener: () => void): unknown;
}
/** Records rejected requests that never reach a decorated controller, including guard failures and 404s. */
@Injectable()
export class RejectedRequestLoggerMiddleware implements NestMiddleware {
  private readonly limiter?: RejectedLogRateLimiter;

  constructor(
    @Inject(AccessLogService) private readonly logs: AccessLogService,
    @Inject(REJECTED_REQUEST_LOG_OPTIONS) private readonly options: RejectedRequestLogOptions,
  ) {
    this.limiter = options.rateLimit === false ? undefined : new RejectedLogRateLimiter(options.rateLimit);
  }
  use(request: RequestData, response: ResponseData, next: () => void): void {
    if (
      this.options.skipPaths?.includes(request.path) ||
      this.options.skipPrefixes?.some((path) => request.path.startsWith(path))
    ) {
      next();
      return;
    }
    const start = Date.now();
    const requestId = getCorrelationId();
    let completed = false;
    response.on('finish', () => {
      if (completed) return;
      completed = true;
      if (response.statusCode < 400 || request[HTTP_ACCESS_CAPTURED]) return;
      request[HTTP_ACCESS_CAPTURED] = true;
      // Only the transport address (request.ip honours the app's trust-proxy setting).
      // X-Forwarded-For / X-Real-IP are client-controlled unless a trusted proxy rewrote them.
      const clientIp = request.ip || request.socket?.remoteAddress || '';
      const allowed = !this.limiter || this.limiter.allow(response.statusCode, clientIp);
      const suppressed = this.limiter?.drainSuppressed();
      if (suppressed) void this.logs.log(suppressedRejectionsLog(suppressed)).catch(() => {});
      if (!allowed) return;
      const header = (name: string) => {
        const value = request.headers[name];
        return Array.isArray(value) ? value[0] : value;
      };
      const ip = this.options.retainClientIp ? clientIp : undefined;
      void this.logs.log({
        action: `http:${response.statusCode}`,
        describe: `${request.method} ${request.path}`,
        module: 'http',
        userId: request.user?.id,
        username: request.user?.username || request.user?.email,
        requestUrl: urlFilter.sanitizeUrl(request.originalUrl || request.url, REJECTED_URL_SENSITIVE_PARAMETERS),
        method: request.method,
        ip,
        userAgent: header('user-agent'),
        requestTime: new Date(start),
        responseTime: Date.now() - start,
        statusCode: response.statusCode,
        requestId,
        exception: `HTTP ${response.statusCode}`,
      }, {
        completionObservation: request[HTTP_COMPLETION_OBSERVATION],
        completionResponse: request[HTTP_COMPLETION_RESPONSE],
      }).catch(() => {});
    });
    next();
  }
}
