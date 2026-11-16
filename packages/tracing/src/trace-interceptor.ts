import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable, throwError, defer } from 'rxjs';
import { catchError, finalize } from 'rxjs/operators';
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

    // Spans live in memory and may be exported: keep the path only (no query string).
    const path = String(request.url ?? '').split(/[?#]/, 1)[0];
    const routePath = request.route?.path ?? path;
    const spanName = `${request.method} ${routePath}`;
    return defer(() => {
      const span = this.tracer.startSpan(spanName, {
        traceId: traceCtx?.traceId,
        parentSpanId: traceCtx?.parentSpanId,
        spanId: traceCtx?.spanId,
        attributes: {
          'http.method': request.method,
          'http.url': path,
          'http.route': routePath,
          'http.user_agent': request.headers?.['user-agent'],
          // request.ip honours the app's trust-proxy setting; raw X-Forwarded-For is client-controlled.
          'http.client_ip': request.ip || '',
        },
      });

      let failed = false;
      return defer(() => next.handle()).pipe(
        catchError((error) => {
          failed = true;
          const statusCode = error?.status ?? 500;
          span.setAttribute('http.status_code', statusCode);
          span.setAttribute('error.type', error?.constructor?.name ?? 'Error');
          span.setAttribute('error.message', error instanceof Error ? error.message : String(error));
          span.setStatus('ERROR', error instanceof Error ? error.message : String(error));
          span.addEvent('exception', {
            'exception.type': error?.constructor?.name ?? 'Error',
            'exception.message': error instanceof Error ? error.message : String(error),
            'exception.stacktrace':
              error instanceof Error && error.stack ? error.stack.slice(0, 4096) : undefined,
          });
          return throwError(() => error);
        }),
        finalize(() => {
          if (!failed) {
            const statusCode = context.switchToHttp().getResponse()?.statusCode ?? 200;
            span.setAttribute('http.status_code', statusCode);
            span.setStatus(statusCode < 400 ? 'OK' : 'ERROR');
          }
          span.end();
        }),
      );
    });
  }
}
