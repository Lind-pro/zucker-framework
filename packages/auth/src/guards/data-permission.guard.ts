import {
  Injectable,
  CanActivate,
  ExecutionContext,
  Logger,
  Inject,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY, DATA_PERMISSION_KEY } from '../decorators/constants';
import type { DataPermissionOptions } from '../decorators';
import type { Authentication } from '../interfaces';
import type { DataAccessHandler, AuthorizingContext } from '../data-access/data-access-handler';
import { DATA_ACCESS_HANDLERS } from '../data-access/data-access-handler';
import { mergeResults, allowResult } from '../data-access/data-access-result';
import type { DataAccessResult } from '../data-access/data-access-result';
import { RESOURCE_KEY, ACTION_KEY } from '../decorators/constants';
import type { ResourceOptions, ActionOptions } from '../decorators';
import { DATABASE_ADAPTER } from '@zucker/crud';
export { DATABASE_ADAPTER };

/** Key to store data access result on the request for downstream use */
export const DATA_ACCESS_RESULT_KEY = '__dataAccessResult';

@Injectable()
export class DataPermissionGuard implements CanActivate {
  private readonly logger = new Logger(DataPermissionGuard.name);

  constructor(
    private reflector: Reflector,
    @Optional()
    @Inject(DATA_ACCESS_HANDLERS)
    private readonly handlers: DataAccessHandler[] | null,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Skip data permission checks on @Public() routes — no authenticated user context
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const metadata = this.reflector.get<DataPermissionOptions>(
      DATA_PERMISSION_KEY,
      context.getHandler(),
    );

    if (!metadata || metadata.skipDataPermission) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const auth: Authentication | undefined = request.auth || request.user;

    if (!auth || !this.isAuthentication(auth)) {
      // Fall back to simple user check for backward compatibility
      const user = request.user;
      if (!user || !user.id) {
        this.logger.warn('数据权限检查失败: 用户未登录');
        return false;
      }
      // No handlers or no authentication object — allow (legacy behavior)
      return true;
    }

    if (!this.handlers || this.handlers.length === 0) {
      return true;
    }

    // Resolve resource/action metadata
    const resourceMeta = this.reflector.get<ResourceOptions>(
      RESOURCE_KEY,
      context.getClass(),
    );
    const actionMeta = this.reflector.get<ActionOptions>(
      ACTION_KEY,
      context.getHandler(),
    );

    const dataType =
      metadata.dataType ||
      resourceMeta?.id ||
      this.getDataTypeFromRequest(request);
    const action =
      actionMeta?.action || this.getActionFromMethod(request.method);
    const permissionId = resourceMeta?.id || dataType;

    // Get the user's permissions and find matching data access configs
    const permissions = auth.getPermissions();
    const permission = permissions.find((p) => p.id === permissionId);

    if (!permission || !permission.dataAccesses || permission.dataAccesses.length === 0) {
      // No data access configs for this permission — allow
      return true;
    }

    // Filter configs matching the current action
    const matchingConfigs = permission.dataAccesses.filter(
      (c) => c.action === action || c.action === '*',
    );

    if (matchingConfigs.length === 0) {
      return true;
    }

    // Build authorizing context
    const authContext: AuthorizingContext = {
      authentication: auth,
      permissionId,
      action,
      dataType,
      request,
    };

    // Execute all matching handlers and merge results
    const results: DataAccessResult[] = [];
    for (const config of matchingConfigs) {
      for (const handler of this.handlers) {
        if (handler.isSupport(config)) {
          const result = await handler.handle(config, authContext);
          results.push(result);
          break;
        }
      }
    }

    const merged = results.length > 0 ? mergeResults(results) : allowResult();

    // Store the merged result on the request for downstream services
    request[DATA_ACCESS_RESULT_KEY] = merged;

    if (!merged.allowed) {
      const user = auth.getUser();
      this.logger.warn(
        `数据权限检查失败: 用户 ${user.username} 对资源 ${dataType} 没有 ${action} 权限`,
      );
      return false;
    }

    return true;
  }

  private isAuthentication(obj: unknown): obj is Authentication {
    return (
      typeof obj === 'object' &&
      obj !== null &&
      'getUser' in obj &&
      'getPermissions' in obj &&
      typeof (obj as Authentication).getUser === 'function'
    );
  }

  private getActionFromMethod(method: string): string {
    switch (method.toUpperCase()) {
      case 'GET':
        return 'query';
      case 'POST':
        return 'add';
      case 'PUT':
      case 'PATCH':
        return 'update';
      case 'DELETE':
        return 'delete';
      default:
        return '';
    }
  }

  private getDataTypeFromRequest(request: {
    path: string;
    route?: { path?: string };
  }): string {
    const path = request.route?.path || request.path;
    return path.split('/').filter(Boolean)[0] || 'unknown';
  }
}
