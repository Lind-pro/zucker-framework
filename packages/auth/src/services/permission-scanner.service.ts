import { Injectable } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { RESOURCE_KEY, ACTION_KEY, AUTHORIZE_KEY } from '../decorators/constants';
import type {
  ResourceOptions,
  ActionOptions,
  AuthorizeResourceOptions,
  ResolvedAuthorizeOptions,
} from '../decorators';

export interface ScannedPermission {
  id: string;
  name: string;
  description: string;
  status: boolean;
  actions: Array<{
    action: string;
    name: string;
    description: string;
    properties?: Record<string, unknown>;
  }>;
  optionalFields?: Array<{ name: string; description: string }>;
}

@Injectable()
export class PermissionScannerService {
  constructor(
    private readonly discoveryService: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  scanPermissions(): ScannedPermission[] {
    const controllers = this.discoveryService.getControllers();
    const permissionsMap = new Map<string, ScannedPermission>();

    for (const wrapper of controllers) {
      const controllerClass = wrapper.metatype;
      if (!controllerClass) continue;

      const authorizeOptions = this.reflector.get<ResolvedAuthorizeOptions | undefined>(
        AUTHORIZE_KEY,
        controllerClass,
      );
      const resourceOptions: ResourceOptions | undefined =
        this.reflector.get(RESOURCE_KEY, controllerClass);
      const controllerResources = authorizeOptions?.resources?.length
        ? authorizeOptions.resources
        : resourceOptions
          ? [resourceOptions]
          : [];

      if (controllerResources.length === 0) continue;

      for (const resource of controllerResources) {
        this.ensurePermission(permissionsMap, resource);
      }

      const instance = wrapper.instance;
      const prototype = Object.getPrototypeOf(instance);
      const methodNames = this.metadataScanner
        .getAllMethodNames(prototype)
        .filter(
          (name) =>
            typeof prototype[name] === 'function' &&
            name !== 'constructor',
        );

      for (const methodName of methodNames) {
        const methodAuthorize = this.reflector.get<ResolvedAuthorizeOptions | undefined>(
          AUTHORIZE_KEY,
          instance[methodName],
        );
        if (methodAuthorize?.resources?.length) {
          for (const resource of methodAuthorize.resources) {
            const permission = this.ensurePermission(permissionsMap, resource);
            for (const action of resource.actions ?? []) {
              this.addAction(permission, action);
            }
          }
          continue;
        }

        const actionOptions: ActionOptions | undefined =
          this.reflector.get(ACTION_KEY, instance[methodName]);

        if (!actionOptions || controllerResources.length !== 1) {
          continue;
        }

        const permission = this.ensurePermission(permissionsMap, controllerResources[0]);
        this.addAction(permission, actionOptions);
      }
    }

    return Array.from(permissionsMap.values());
  }

  private ensurePermission(
    permissionsMap: Map<string, ScannedPermission>,
    resource: Pick<ResourceOptions, 'id' | 'name' | 'description' | 'optionalFields'>,
  ): ScannedPermission {
    if (!permissionsMap.has(resource.id)) {
      permissionsMap.set(resource.id, {
        id: resource.id,
        name: resource.name,
        description: resource.description || '',
          status: true,
          actions: [],
        optionalFields: resource.optionalFields || [],
        });
      }

    return permissionsMap.get(resource.id)!;
  }

  private addAction(permission: ScannedPermission, actionOptions: ActionOptions): void {
    if (
      permission.actions.some((action) => action.action === actionOptions.action)
    ) {
      return;
    }

    permission.actions.push({
      action: actionOptions.action,
      name: actionOptions.name,
      description: actionOptions.description || '',
      properties: { supportDataAccessTypes: [] },
    });
  }
}
