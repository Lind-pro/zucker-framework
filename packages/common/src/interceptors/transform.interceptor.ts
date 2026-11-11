import {
  Injectable,
  SetMetadata,
  type NestInterceptor,
  type ExecutionContext,
  type CallHandler,
  HttpStatus,
  StreamableFile,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * 统一响应格式
 */
export interface ApiResponse<T = unknown> {
  status: number;
  code?: string;
  message: string;
  result: T;
  timestamp: number;
}

/** Metadata key of {@link RawResponse} (registered symbol: identical across CJS/ESM copies). */
export const RAW_RESPONSE_METADATA = Symbol.for('zucker:common:raw-response');

/**
 * Marks a controller or handler whose return value is the response body as is: TransformInterceptor
 * does not wrap it in the `{ status, code, message, result, timestamp }` envelope.
 */
export const RawResponse = (): ClassDecorator & MethodDecorator => SetMetadata(RAW_RESPONSE_METADATA, true);

// Nest route metadata keys (`@nestjs/common/constants`), read without importing Nest internals.
const HEADERS_METADATA = '__headers__';
const SSE_METADATA = '__sse__';

type Target = object | undefined;
const metadata = (key: unknown, target: Target): unknown =>
  target && typeof Reflect.getMetadata === 'function' ? Reflect.getMetadata(key, target) : undefined;

const isJsonType = (value: unknown): boolean =>
  typeof value !== 'string' || /^\s*application\/(?:[\w.+-]+\+)?json\b/i.test(value);

/** `@Header('Content-Type', …)` declared on the handler with a non-JSON media type. */
function declaresNonJsonType(handler: Target): boolean {
  const headers = metadata(HEADERS_METADATA, handler);
  if (!Array.isArray(headers)) return false;
  return headers.some((header: { name?: unknown; value?: unknown }) =>
    typeof header?.name === 'string' && header.name.toLowerCase() === 'content-type' && !isJsonType(header.value));
}

/** A non-JSON Content-Type the handler already set on the response (e.g. `@Res({ passthrough: true })`). */
function respondsNonJson(context: ExecutionContext): boolean {
  if (typeof context.getType !== 'function' || context.getType() !== 'http') return false;
  const response = context.switchToHttp().getResponse<{ getHeader?: (name: string) => unknown } | undefined>();
  const type = typeof response?.getHeader === 'function' ? response.getHeader('content-type') : undefined;
  return type !== undefined && !isJsonType(Array.isArray(type) ? type[0] : type);
}

/**
 * Whether the handler's response is passed through unchanged: `@RawResponse()`, server-sent events
 * (`@Sse()`), a declared non-JSON Content-Type (e.g. Prometheus text exposition) or one set on the
 * response. Other values keep the public JSON envelope.
 */
function isRawRoute(context: ExecutionContext): boolean {
  const handler = typeof context.getHandler === 'function' ? context.getHandler() : undefined;
  const controller = typeof context.getClass === 'function' ? context.getClass() : undefined;
  return metadata(RAW_RESPONSE_METADATA, handler) === true
    || metadata(RAW_RESPONSE_METADATA, controller) === true
    || metadata(SSE_METADATA, handler) === true
    || declaresNonJsonType(handler);
}

@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<
  T,
  ApiResponse<T> | StreamableFile | T
> {
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<ApiResponse<T> | StreamableFile | T> {
    const raw = isRawRoute(context);
    return next.handle().pipe(
      map((data) =>
        raw || data instanceof StreamableFile || respondsNonJson(context)
          ? data
          : {
              status: HttpStatus.OK,
              code: 'success',
              message: 'success',
              result: data,
              timestamp: Date.now(),
            },
      ),
    );
  }
}
