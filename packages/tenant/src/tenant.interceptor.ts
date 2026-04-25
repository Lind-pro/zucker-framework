import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { BusinessException } from '@zucker/core';
import { TenantContext } from './tenant-context';

export type TenantResolveStrategy = 'header' | 'jwt' | 'subdomain';

export interface TenantInterceptorOptions {
  /** 租户解析策略，默认 header */
  strategy?: TenantResolveStrategy;
  /** Header 名称，默认 X-Tenant-ID */
  headerName?: string;
  /** JWT 中的租户字段名，默认 tenantId */
  jwtField?: string;
  /** 是否必填，默认 false */
  required?: boolean;
}

/**
 * NestJS 拦截器 — 从请求中提取租户 ID
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  private options: Required<TenantInterceptorOptions>;

  constructor(options?: TenantInterceptorOptions) {
    this.options = {
      strategy: options?.strategy ?? 'header',
      headerName: options?.headerName ?? 'x-tenant-id',
      jwtField: options?.jwtField ?? 'tenantId',
      required: options?.required ?? false,
    };
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const tenantId = this.resolveTenantId(request);

    if (this.options.required && !tenantId) {
      throw new BusinessException('Tenant ID is required but not provided', 'TENANT_REQUIRED', 400);
    }

    if (!tenantId) {
      return next.handle();
    }

    return new Observable((subscriber) => {
      TenantContext.runWithTenantAsync(tenantId, async () => {
        return new Promise<void>((resolve, reject) => {
          next.handle().subscribe({
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
      }).catch((err) => subscriber.error(err));
    });
  }

  private resolveTenantId(request: { headers?: Record<string, string | undefined>; user?: Record<string, unknown> }): string | undefined {
    switch (this.options.strategy) {
      case 'header':
        return request.headers?.[this.options.headerName.toLowerCase()];
      case 'jwt':
        return request.user?.[this.options.jwtField] as string | undefined;
      case 'subdomain': {
        const host = request.headers?.host ?? '';
        const parts = host.split('.');
        return parts.length > 2 ? parts[0] : undefined;
      }
      default:
        return undefined;
    }
  }
}
