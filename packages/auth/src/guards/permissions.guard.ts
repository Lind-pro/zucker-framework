import {
  Injectable,
  CanActivate,
  ExecutionContext,
  Logger,
  ForbiddenException,
  Inject,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  IS_PUBLIC_KEY,
  PERMISSIONS_KEY,
  RESOURCE_KEY,
  ACTION_KEY,
  AUTHORIZE_KEY,
  DIMENSION_KEY,
} from '../decorators/constants';
import type {
  ResourceOptions,
  ActionOptions,
  AuthorizeResourceOptions,
  DimensionOptions,
  ResolvedAuthorizeOptions,
} from '../decorators';
import { PermissionService } from '../services/permission.service';

export const PERMISSION_SERVICE = Symbol('PERMISSION_SERVICE');
export const PERMISSIONS_GUARD_OPTIONS = Symbol('PERMISSIONS_GUARD_OPTIONS');
export interface PermissionsGuardOptions {
  /** Deny access on authorization/provider errors instead of propagating them. */
  errorPolicy?: 'throw' | 'deny';
  /** Select a safe diagnostic identity without altering request.user. */
  denialIdentity?: (user: { id?: string; username?: string }) => string | undefined;
}

@Injectable()
export class PermissionsGuard implements CanActivate {
  private readonly logger = new Logger(PermissionsGuard.name);

  constructor(
    private reflector: Reflector,
    @Inject(PermissionService) private permissionService: PermissionService,
    @Optional()
    @Inject(PERMISSIONS_GUARD_OPTIONS)
    private readonly options: PermissionsGuardOptions = {},
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      return await this.evaluate(context);
    } catch (error) {
      if (this.options.errorPolicy === 'deny') return false;
      throw error;
    }
  }

  private async evaluate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const authorizeOptions = this.resolveAuthorizeOptions(context);

    if (isPublic || authorizeOptions?.ignore) {
      return true;
    }

    // 优先读取字符串权限装饰器
    const stringPermissions = this.reflector.getAllAndOverride<string[] | undefined>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    // 读取 Resource/Action 装饰器
    const resourceOptions = this.reflector.get<ResourceOptions>(RESOURCE_KEY, context.getClass());
    const actionOptions = this.reflector.get<ActionOptions>(ACTION_KEY, context.getHandler());

    // 读取 @DimensionCheck / @RequiresRoles 装饰器
    const dimensionOptions = this.reflector.getAllAndOverride<DimensionOptions | undefined>(
      DIMENSION_KEY,
      [context.getHandler(), context.getClass()],
    );

    let requiredPermissions: string[] = [];

    const hasPermissionsDecorator = stringPermissions !== undefined;

    if (hasPermissionsDecorator) {
      if (stringPermissions.length > 0) {
        requiredPermissions = stringPermissions;
      } else {
        // @Permissions() 空调用 - 只需要登录
        return !!request.user && !!request.user.id;
      }
    } else if (authorizeOptions) {
      if (authorizeOptions.permissions !== undefined && authorizeOptions.permissions.length > 0) {
        requiredPermissions = authorizeOptions.permissions;
      } else if (
        authorizeOptions.permissions !== undefined &&
        authorizeOptions.resources.length === 0 &&
        authorizeOptions.dimensions.length === 0
      ) {
        return !!request.user && !!request.user.id;
      }
    } else if (resourceOptions && actionOptions) {
      requiredPermissions = [`${resourceOptions.id}:${actionOptions.action}`];
    } else if (dimensionOptions) {
      // @DimensionCheck / @RequiresRoles — 只需登录 + 维度检查
      requiredPermissions = [];
    } else {
      const handler = context.getHandler().name;
      const controller = context.getClass().name;
      this.logger.error(
        `[Security] Access denied: Endpoint ${controller}.${handler} has no permission metadata. ` +
          `Add @Public() for public endpoints or @Permissions() for protected ones.`,
      );
      throw new ForbiddenException(
        `Endpoint ${controller}.${handler} is not configured with permission metadata. ` +
          `Contact the administrator.`,
      );
    }

    const { user } = request;
    if (!user || !user.id) {
      return false;
    }

    // Check string/resource permissions
    if (requiredPermissions.length > 0) {
      const hasPermission = await this.permissionService.hasPermission(
        user.id,
        requiredPermissions,
      );
      if (!hasPermission) {
        this.logger.warn(
          `Access Denied: User ${this.options.denialIdentity ? this.options.denialIdentity(user) : user.username} lacks permissions [${requiredPermissions.join(', ')}]`,
        );
        return false;
      }
    }

    if (authorizeOptions?.resources.length) {
      const hasResourcePermission = await this.hasAuthorizeResourcePermission(
        user.id,
        authorizeOptions,
      );
      if (!hasResourcePermission) {
        this.logger.warn(
          `Access Denied: User ${this.options.denialIdentity ? this.options.denialIdentity(user) : user.username} lacks authorize resources [${authorizeOptions.resources.map((resource) => resource.id).join(', ')}]`,
        );
        throw new ForbiddenException(authorizeOptions.message);
      }
    }

    if (authorizeOptions?.dimensions.length) {
      const hasAuthorizeDimension = await this.hasAuthorizeDimensions(user.id, authorizeOptions);
      if (!hasAuthorizeDimension) {
        this.logger.warn(
          `Access Denied: User ${this.options.denialIdentity ? this.options.denialIdentity(user) : user.username} lacks authorize dimensions [${authorizeOptions.dimensions.map((dimension) => `${dimension.type}:${dimension.ids.join(',')}`).join('; ')}]`,
        );
        throw new ForbiddenException(authorizeOptions.message);
      }
    }

    // Check dimension (role/department) requirements
    if (dimensionOptions) {
      const hasDimension = await this.permissionService.hasDimension(
        user.id,
        dimensionOptions.type,
        dimensionOptions.ids,
        this.normalizeLogical(dimensionOptions.logical),
      );
      if (!hasDimension) {
        this.logger.warn(
          `Access Denied: User ${this.options.denialIdentity ? this.options.denialIdentity(user) : user.username} lacks dimension ${dimensionOptions.type} [${dimensionOptions.ids.join(', ')}]`,
        );
        return false;
      }
    }

    return true;
  }

  private async hasAuthorizeResourcePermission(
    userId: string,
    authorizeOptions: ResolvedAuthorizeOptions,
  ): Promise<boolean> {
    const checks = await Promise.all(
      authorizeOptions.resources.map((resource) =>
        this.permissionService.hasResourceActions(
          userId,
          resource.id,
          resource.actions?.map((action) => action.action) ?? [],
        ),
      ),
    );

    if (authorizeOptions.logical === 'AND') {
      return checks.every(Boolean);
    }
    return checks.some(Boolean);
  }

  private async hasAuthorizeDimensions(
    userId: string,
    authorizeOptions: ResolvedAuthorizeOptions,
  ): Promise<boolean> {
    const checks = await Promise.all(
      authorizeOptions.dimensions.map((dimension) =>
        this.permissionService.hasDimension(
          userId,
          dimension.type,
          dimension.ids,
          this.normalizeLogical(dimension.logical),
        ),
      ),
    );

    if (authorizeOptions.logical === 'AND') {
      return checks.every(Boolean);
    }
    return checks.some(Boolean);
  }

  private resolveAuthorizeOptions(context: ExecutionContext): ResolvedAuthorizeOptions | undefined {
    const classOptions = this.reflector.get<ResolvedAuthorizeOptions | undefined>(
      AUTHORIZE_KEY,
      context.getClass(),
    );
    const handlerOptions = this.reflector.get<ResolvedAuthorizeOptions | undefined>(
      AUTHORIZE_KEY,
      context.getHandler(),
    );

    if (!classOptions && !handlerOptions) {
      return undefined;
    }

    if (!classOptions) {
      return this.cloneAuthorizeOptions(handlerOptions!);
    }
    if (!handlerOptions) {
      return this.cloneAuthorizeOptions(classOptions);
    }

    const merged = handlerOptions.merge
      ? this.cloneAuthorizeOptions(classOptions)
      : this.createEmptyAuthorizeOptions(classOptions);

    if (handlerOptions.ignore) {
      merged.ignore = true;
    }
    merged.message = handlerOptions.message;
    merged.logical = handlerOptions.logical;
    merged.phased = handlerOptions.phased;
    merged.description = [...handlerOptions.description];
    merged.dataPermission = handlerOptions.dataPermission
      ? { ...handlerOptions.dataPermission }
      : merged.dataPermission;
    if (handlerOptions.permissions !== undefined) {
      merged.permissions = [...handlerOptions.permissions];
    }
    merged.resources = this.mergeResources(merged.resources, handlerOptions.resources);
    merged.dimensions = this.mergeDimensions(merged.dimensions, handlerOptions.dimensions);

    return merged;
  }

  private mergeResources(
    base: AuthorizeResourceOptions[],
    override: AuthorizeResourceOptions[],
  ): AuthorizeResourceOptions[] {
    const merged = base.map((resource) => this.cloneResource(resource));

    for (const resource of override) {
      const existingIndex = merged.findIndex((item) => item.id === resource.id);
      if (existingIndex === -1) {
        merged.push(this.cloneResource(resource));
        continue;
      }

      if (resource.merge === false) {
        merged.splice(existingIndex, 1, this.cloneResource(resource));
        continue;
      }

      const existing = merged[existingIndex];
      const actions = new Map<string, ActionOptions>();
      for (const action of existing.actions ?? []) {
        actions.set(action.action, { ...action });
      }
      for (const action of resource.actions ?? []) {
        actions.set(action.action, { ...action });
      }

      merged[existingIndex] = {
        ...existing,
        ...this.cloneResource(resource),
        actions: Array.from(actions.values()),
      };
    }

    return merged;
  }

  private mergeDimensions(
    base: DimensionOptions[],
    override: DimensionOptions[],
  ): DimensionOptions[] {
    const merged = new Map<string, DimensionOptions>();

    for (const dimension of base) {
      merged.set(dimension.type, {
        type: dimension.type,
        ids: [...dimension.ids],
        logical: dimension.logical,
      });
    }

    for (const dimension of override) {
      const existing = merged.get(dimension.type);
      if (!existing) {
        merged.set(dimension.type, {
          type: dimension.type,
          ids: [...dimension.ids],
          logical: dimension.logical,
        });
        continue;
      }

      merged.set(dimension.type, {
        type: dimension.type,
        ids: Array.from(new Set([...existing.ids, ...dimension.ids])),
        logical: dimension.logical ?? existing.logical,
      });
    }

    return Array.from(merged.values());
  }

  private cloneAuthorizeOptions(options: ResolvedAuthorizeOptions): ResolvedAuthorizeOptions {
    return {
      resources: options.resources.map((resource) => this.cloneResource(resource)),
      dimensions: options.dimensions.map((dimension) => ({
        type: dimension.type,
        ids: [...dimension.ids],
        logical: dimension.logical,
      })),
      permissions: options.permissions ? [...options.permissions] : options.permissions,
      dataPermission: options.dataPermission ? { ...options.dataPermission } : undefined,
      ignore: options.ignore,
      message: options.message,
      merge: options.merge,
      logical: options.logical,
      phased: options.phased,
      description: [...options.description],
    };
  }

  private createEmptyAuthorizeOptions(
    template: ResolvedAuthorizeOptions,
  ): ResolvedAuthorizeOptions {
    return {
      resources: [],
      dimensions: [],
      permissions: undefined,
      dataPermission: undefined,
      ignore: false,
      message: template.message,
      merge: true,
      logical: template.logical,
      phased: template.phased,
      description: [],
    };
  }

  private cloneResource(resource: AuthorizeResourceOptions): AuthorizeResourceOptions {
    return {
      id: resource.id,
      name: resource.name,
      description: resource.description,
      optionalFields: resource.optionalFields?.map((field) => ({ ...field })),
      actions: resource.actions?.map((action) => ({ ...action })),
      merge: resource.merge,
      logical: resource.logical,
      phased: resource.phased,
      group: resource.group ? [...resource.group] : undefined,
    };
  }

  private normalizeLogical(logical: DimensionOptions['logical']): 'AND' | 'OR' {
    return logical === 'AND' ? 'AND' : 'OR';
  }
}
