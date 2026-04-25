import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  HttpStatus,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * 统一响应格式
 * 参考 hsweb ResponseMessage: status + code + message + result + timestamp
 */
export interface ApiResponse<T = unknown> {
  status: number;
  code?: string;
  message: string;
  result: T;
  timestamp: number;
}

@Injectable()
export class TransformInterceptor<T>
  implements NestInterceptor<T, ApiResponse<T>>
{
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<ApiResponse<T>> {
    return next.handle().pipe(
      map(data => ({
        status: HttpStatus.OK,
        code: 'success',
        message: 'success',
        result: data,
        timestamp: Date.now(),
      })),
    );
  }
}
