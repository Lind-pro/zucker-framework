import {
  Injectable,
  CanActivate,
  ExecutionContext,
  Logger,
  Inject,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  IS_PUBLIC_KEY,
  DATA_PERMISSION_KEY,
  RESOURCE_KEY,
  ACTION_KEY,
} from '../decorators/constants';
import type {
  DataPermissionOptions,
  ResourceOptions,
  ActionOptions,
} from '../decorators';
import type { Authentication } from '../interfaces';
import type { DataAccessHandler, AuthorizingContext } from '../data-access/data-access-handler';
import { DATA_ACCESS_HANDLERS } from '../data-access/data-access-handler';
import { mergeResults, denyResult } from '../data-access/data-access-result';
import type { DataAccessResult } from '../data-access/data-access-result';
import { DATABASE_ADAPTER } from '@zucker-framework/crud';
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

    // Class-level @DataPermission applies to every handler unless a handler overrides it.
    const metadata = this.reflector.getAllAndOverride<DataPermissionOptions | undefined>(
      DATA_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
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
      // Without an Authentication object there are no permission data-access configs to
      // evaluate (legacy behaviour). JwtAuthGuard always attaches one, so this path is only
      // reached when the guard runs without it.
      this.logger.warn('DataPermissionGuard: request has no Authentication; data scope not evaluated');
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
    if (permissions.length === 0) {
      // Typical when no AuthenticationSupplier is registered (fromJwtUser carries no
      // permissions): @DataPermission is then a no-op. Say so once per route.
      this.warnNoPermissionsOnce(context, permissionId);
    }
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

    // Execute all matching handlers and merge results. A configured restriction that no
    // handler can evaluate fails closed instead of silently granting unrestricted access.
    const handlers = this.handlers ?? [];
    const results: DataAccessResult[] = [];
    for (const config of matchingConfigs) {
      const handler = handlers.find((candidate) => candidate.isSupport(config));
      if (!handler) {
        this.logger.warn(
          `数据权限检查失败: 没有处理器支持数据权限类型 ${config.type?.id ?? 'unknown'} (${dataType}:${action})`,
        );
        results.push(denyResult());
        continue;
      }
      results.push(await handler.handle(config, authContext));
    }

    const merged = mergeResults(results);

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

  private readonly warnedRoutes = new Set<string>();

  private warnNoPermissionsOnce(context: ExecutionContext, permissionId: string): void {
    const route = `${context.getClass()?.name ?? '?'}.${context.getHandler()?.name ?? '?'}`;
    if (this.warnedRoutes.has(route) || this.warnedRoutes.size >= 1000) return;
    this.warnedRoutes.add(route);
    this.logger.warn(
      `DataPermissionGuard: ${route} has @DataPermission (${permissionId}) but the Authentication carries no permissions; ` +
        'the data scope is not evaluated. Register an AuthenticationSupplier that loads permissions with their dataAccesses.',
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
