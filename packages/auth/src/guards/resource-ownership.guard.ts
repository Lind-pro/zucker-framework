import {
  Inject,
  Injectable,
  Optional,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DATA_PERMISSION_KEY, IS_PUBLIC_KEY, RESOURCE_KEY } from '../decorators/constants';
import type { DataPermissionOptions, ResourceOptions } from '../decorators';
import { DefaultAuthentication } from '../authentication/default-authentication';
import { OwnCreatedDataAccessHandler } from '../data-access/own-created.handler';
import { ownCreatedConfig } from '../data-access/data-access-config';

export const RESOURCE_OWNERSHIP_OPTIONS = Symbol('RESOURCE_OWNERSHIP_OPTIONS');
export interface ResourceOwnershipOptions {
  creatorField?: string;
  /** Explicitly opt in only if collection/create handlers already apply user scoping. */
  allowCollection?: boolean;
  actionForMethod?: (method: string) => string;
}

/** Required ownership for JWT request.user routes; never installs synthetic permissions on the request. */
@Injectable()
export class ResourceOwnershipGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(OwnCreatedDataAccessHandler) private readonly ownership: OwnCreatedDataAccessHandler,
    @Optional()
    @Inject(RESOURCE_OWNERSHIP_OPTIONS)
    private readonly options: ResourceOwnershipOptions = {},
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;
    const metadata = this.reflector.getAllAndOverride<DataPermissionOptions>(
      DATA_PERMISSION_KEY,
      targets,
    );
    if (!metadata || metadata.skipDataPermission) return true;
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (typeof user?.id !== 'string' || !user.id) return false;
    const resource = this.reflector.get<ResourceOptions>(RESOURCE_KEY, context.getClass());
    const dataType = metadata.dataType ?? resource?.id;
    if (!dataType) return false;
    if (!request.params?.id) return this.options.allowCollection === true;
    const method = String(request.method ?? '').toUpperCase();
    const action =
      this.options.actionForMethod?.(method) ??
      (
        {
          GET: 'query',
          POST: 'add',
          PUT: 'update',
          PATCH: 'update',
          DELETE: 'delete',
        } as Record<string, string>
      )[method];
    if (!action) return false;
    try {
      const result = await this.ownership.handle(
        ownCreatedConfig(action, this.options.creatorField),
        {
          authentication: new DefaultAuthentication({ user: { id: user.id, username: user.id } }),
          permissionId: resource?.id ?? dataType,
          action,
          dataType,
          request,
        },
      );
      return result.allowed;
    } catch {
      return false;
    }
  }
}
