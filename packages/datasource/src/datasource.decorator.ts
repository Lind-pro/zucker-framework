import {
  SetMetadata,
  applyDecorators,
  UseInterceptors,
  Injectable,
  type NestInterceptor,
  type ExecutionContext,
  type CallHandler,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { DataSourceHolder } from './datasource-holder';

export const USE_DATASOURCE_KEY = 'zucker:datasource:use';
export const USE_DEFAULT_DATASOURCE_KEY = 'zucker:datasource:useDefault';

export interface UseDataSourceOptions {
  /** 数据源 ID */
  id: string;
  /** 指定数据库 / schema */
  database?: string;
  /** 数据源不存在时是否回退到默认数据源（默认 false） */
  fallbackDefault?: boolean;
}

/**
 * @UseDataSource 方法装饰器 — 自动切换数据源
 *
 * 对应 Java 端 @UseDataSource 注解，支持 fallbackDefault 和 database 选项。
 *
 * @example
 *   @UseDataSource('secondary')
 *   @UseDataSource({ id: 'secondary', fallbackDefault: true })
 */
export function UseDataSource(idOrOptions: string | UseDataSourceOptions) {
  const options: UseDataSourceOptions =
    typeof idOrOptions === 'string' ? { id: idOrOptions } : idOrOptions;

  return applyDecorators(
    SetMetadata(USE_DATASOURCE_KEY, options),
    UseInterceptors(DataSourceInterceptor),
  );
}

/**
 * @UseDefaultDataSource 方法装饰器 — 强制使用默认数据源
 *
 * 对应 Java 端 @UseDefaultDataSource 注解。
 */
export function UseDefaultDataSource() {
  return applyDecorators(
    SetMetadata(USE_DEFAULT_DATASOURCE_KEY, true),
    UseInterceptors(DataSourceInterceptor),
  );
}

@Injectable()
export class DataSourceInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly holder: DataSourceHolder,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const useDefault = this.reflector.get<boolean>(
      USE_DEFAULT_DATASOURCE_KEY,
      context.getHandler(),
    );

    /* 强制默认数据源 */
    if (useDefault) {
      return next.handle();
    }

    const options = this.reflector.get<UseDataSourceOptions>(
      USE_DATASOURCE_KEY,
      context.getHandler(),
    );

    if (!options) {
      return next.handle();
    }

    /* fallbackDefault: 数据源不存在时回退 */
    if (!this.holder.existing(options.id)) {
      if (options.fallbackDefault) {
        return next.handle();
      }
      // 不 fallback 则让 useDataSource 抛出 DataSourceNotFoundException
    }

    return new Observable((subscriber) => {
      let inner: { unsubscribe(): void } | undefined;
      let torndown = false;
      let settle: (() => void) | undefined;
      this.holder
        .useDataSource(options.id, async () => {
          return new Promise<void>((resolve, reject) => {
            if (torndown) {
              resolve();
              return;
            }
            settle = resolve;
            inner = next.handle().subscribe({
              next: (value) => subscriber.next(value),
              error: (err) => {
                subscriber.error(err);
                reject(err);
              },
              complete: () => {
                subscriber.complete();
                resolve();
              },
            });
          });
        })
        .catch((err) => subscriber.error(err));
      // 外部取消订阅（请求中止/超时）时同时取消内部订阅
      return () => {
        torndown = true;
        inner?.unsubscribe();
        // 让 useDataSource 的作用域正常结束，避免悬挂的 Promise
        settle?.();
      };
    });
  }
}
