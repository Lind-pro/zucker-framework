import {
  Injectable,
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

@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<
  T,
  ApiResponse<T> | StreamableFile
> {
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<ApiResponse<T> | StreamableFile> {
    return next.handle().pipe(
      map((data) =>
        data instanceof StreamableFile
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
