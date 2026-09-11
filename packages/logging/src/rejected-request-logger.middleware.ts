import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import { AccessLogService } from './persistent-logs';

export interface RejectedRequestLogOptions {
  skipPaths?: readonly string[];
  skipPrefixes?: readonly string[];
  retainClientIp?: boolean;
}
export const REJECTED_REQUEST_LOG_OPTIONS = Symbol('REJECTED_REQUEST_LOG_OPTIONS');
interface RequestData {
  path: string;
  method: string;
  url: string;
  originalUrl?: string;
  ip?: string;
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
  constructor(
    @Inject(AccessLogService) private readonly logs: AccessLogService,
    @Inject(REJECTED_REQUEST_LOG_OPTIONS) private readonly options: RejectedRequestLogOptions,
  ) {}
  use(request: RequestData, response: ResponseData, next: () => void): void {
    if (
      this.options.skipPaths?.includes(request.path) ||
      this.options.skipPrefixes?.some((path) => request.path.startsWith(path))
    ) {
      next();
      return;
    }
    const start = Date.now();
    response.on('finish', () => {
      if (response.statusCode < 400) return;
      const header = (name: string) => {
        const value = request.headers[name];
        return Array.isArray(value) ? value[0] : value;
      };
      const ip = this.options.retainClientIp
        ? header('x-forwarded-for')?.split(',')[0].trim() || header('x-real-ip') || request.ip || ''
        : undefined;
      void this.logs.log({
        action: `http:${response.statusCode}`,
        describe: `${request.method} ${request.path}`,
        module: 'http',
        userId: request.user?.id,
        username: request.user?.username || request.user?.email,
        requestUrl: request.originalUrl || request.url,
        method: request.method,
        ip,
        userAgent: header('user-agent'),
        requestTime: new Date(start),
        responseTime: Date.now() - start,
      });
    });
    next();
  }
}
