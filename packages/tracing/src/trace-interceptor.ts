import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { InMemoryTracer } from './tracer';
import { getTraceContext } from './trace-middleware';

/**
 * NestJS 拦截器：自动为每个 HTTP 请求创建 Span
 */
@Injectable()
export class TraceInterceptor implements NestInterceptor {
  constructor(private readonly tracer: InMemoryTracer) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const traceCtx = getTraceContext();

    const routePath = request.route?.path ?? request.url;
    const spanName = `${request.method} ${routePath}`;
    const span = this.tracer.startSpan(spanName, {
      traceId: traceCtx?.traceId,
      parentSpanId: traceCtx?.parentSpanId,
      attributes: {
        'http.method': request.method,
        'http.url': request.url,
        'http.route': routePath,
        'http.user_agent': request.headers?.['user-agent'],
        'http.client_ip': request.ip || request.headers?.['x-forwarded-for'] || '',
      },
    });

    return next.handle().pipe(
      tap(() => {
        const response = context.switchToHttp().getResponse();
        const statusCode = response?.statusCode ?? 200;
        span.setAttribute('http.status_code', statusCode);
        span.setStatus(statusCode < 400 ? 'OK' : 'ERROR');
        span.end();
      }),
      catchError((error) => {
        const statusCode = error?.status ?? 500;
        span.setAttribute('http.status_code', statusCode);
        span.setAttribute('error.type', error?.constructor?.name ?? 'Error');
        span.setAttribute('error.message', error instanceof Error ? error.message : String(error));
        span.setStatus('ERROR', error instanceof Error ? error.message : String(error));
        span.addEvent('exception', {
          'exception.type': error?.constructor?.name ?? 'Error',
          'exception.message': error instanceof Error ? error.message : String(error),
          'exception.stacktrace': error instanceof Error ? error.stack : undefined,
        });
        span.end();
        return throwError(() => error);
      }),
    );
  }
}
