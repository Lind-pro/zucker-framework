import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  HttpException,
  Inject,
  Optional,
  Param,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UseGuards,
  type CanActivate,
  type InjectionToken,
  type Type,
} from '@nestjs/common';
import { JwtAuthGuard, Permissions, PermissionsGuard } from '@zucker-framework/auth';
import { RateLimit, RateLimitGuard } from '@zucker-framework/rate-limiter';
import type { ManagementFeature, ManagementRecordFeature, ResolvedManagementOptions } from './management.options';
import type { ManagementConnectionsPort } from './management.ports';
import type { BackOfficeManagementService, ManagementResource } from './management.service';
import { MANAGEMENT_CONNECTIONS } from './management.tokens';

interface ManagementRequest {
  user: { id: string };
  headers: Record<string, string | string[] | undefined>;
}

/** Feature → route segment and service resource name. */
export const MANAGEMENT_RECORD_ROUTES: Readonly<Record<ManagementRecordFeature, { route: string; resource: ManagementResource }>> = Object.freeze({
  apiKeys: { route: 'api-keys', resource: 'api-keys' },
  orders: { route: 'orders', resource: 'orders' },
  // Provider-billed subscription records; plan subscriptions live elsewhere (`/management/subscriptions`).
  billingSubscriptions: { route: 'billing-subscriptions', resource: 'subscriptions' },
  jobs: { route: 'jobs', resource: 'jobs' },
  deliveries: { route: 'deliveries', resource: 'deliveries' },
  files: { route: 'files', resource: 'files' },
  accessLogs: { route: 'access-logs', resource: 'access-logs' },
  operationLogs: { route: 'operation-logs', resource: 'operation-logs' },
  credits: { route: 'credits', resource: 'credits' },
});

/** Storage faults become a generic 503; validation and permission errors pass through. */
async function result<T>(work: () => Promise<T> | T) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpException) throw error;
    throw new ServiceUnavailableException('Management data is temporarily unavailable');
  }
}

export interface ManagementControllerDependencies {
  /** Token of the projection service (default: the `BackOfficeManagementService` class the module registers). */
  service: InjectionToken;
  /** Token of the connections inspector (default `MANAGEMENT_CONNECTIONS`). */
  connections?: InjectionToken;
}

type Method = (...args: never[]) => unknown;
function route(prototype: object, name: string, decorators: MethodDecorator[], parameters: Array<(index: number) => ParameterDecorator> = []) {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, name)!;
  parameters.forEach((decorator, index) => decorator(index)(prototype, name, index));
  for (const decorator of decorators.reverse()) decorator(prototype, name, descriptor);
  Object.defineProperty(prototype, name, descriptor);
}

/**
 * `<path>/<route>` read models (`GET`, `{data,total,page,pageSize}`), credit balance/lots/grant and the
 * connection inventory. Only enabled features get a route. Every response is `Cache-Control: private, no-store`.
 */
export function createManagementController(options: ResolvedManagementOptions, deps: ManagementControllerDependencies): Type<unknown> {
  const guards: Type<CanActivate>[] = [...(options.guards ?? [JwtAuthGuard, PermissionsGuard]), ...(options.rateLimit ? [RateLimitGuard] : [])];

  class ManagementController {
    readonly origins: ReadonlySet<string>;
    constructor(
      @Inject(deps.service) readonly management: BackOfficeManagementService,
      @Optional() @Inject(deps.connections ?? MANAGEMENT_CONNECTIONS) readonly connections?: ManagementConnectionsPort,
    ) {
      this.origins = new Set(options.trustedOrigins().map((value) => value.trim()).filter(Boolean));
    }
    configuration() {
      return result(() => this.connections!.inspect());
    }
    records(resource: ManagementResource, query: Record<string, unknown>) {
      return result(() => this.management.list(resource, query ?? {}));
    }
    balance(owner: string) {
      return result(() => this.management.creditBalance(owner));
    }
    lots(owner: string, query: Record<string, unknown>) {
      return result(() => this.management.creditLots(owner, query ?? {}));
    }
    grant(req: ManagementRequest, owner: string, body: unknown) {
      // State change from a browser: exact trusted Origin, never a cross-site fetch.
      if (typeof req.headers.origin !== 'string' || !this.origins.has(req.headers.origin) || req.headers['sec-fetch-site'] === 'cross-site')
        throw new ForbiddenException('Untrusted management request origin');
      return result(() => this.management.grant(req.user.id, owner, req.headers['idempotency-key'], body));
    }
  }
  const prototype = ManagementController.prototype as unknown as Record<string, Method>;
  const read = (feature: ManagementFeature | 'creditGrant') => [Permissions(options.permissions[feature]), Header('Cache-Control', 'private, no-store')];
  const enabled = options.features;

  if (enabled.connections) route(prototype, 'configuration', [Get('connections'), ...read('connections')]);
  for (const [feature, { route: segment, resource }] of Object.entries(MANAGEMENT_RECORD_ROUTES) as Array<[ManagementRecordFeature, { route: string; resource: ManagementResource }]>) {
    if (!enabled[feature]) continue;
    // One method per route so Nest keeps distinct handler metadata (permissions differ per feature).
    const name = `list_${feature}`;
    Object.defineProperty(prototype, name, {
      value: function (this: ManagementController, query: Record<string, unknown>) { return this.records(resource, query); },
      writable: true, configurable: true, enumerable: false,
    });
    route(prototype, name, [Get(segment), ...read(feature)], [() => Query()]);
  }
  if (enabled.creditAccounts) {
    route(prototype, 'balance', [Get('credits/:ownerId/balance'), ...read('creditAccounts')], [() => Param('ownerId')]);
    route(prototype, 'lots', [Get('credits/:ownerId/lots'), ...read('creditAccounts')], [() => Param('ownerId'), () => Query()]);
    route(prototype, 'grant', [Post('credits/:ownerId/grants'), Permissions(options.permissions.creditGrant), HttpCode(200),
      Header('Cache-Control', 'private, no-store')], [() => Req(), () => Param('ownerId'), () => Body()]);
  }
  Controller(options.path)(ManagementController);
  UseGuards(...guards)(ManagementController);
  if (options.rateLimit) RateLimit({ limiter: options.rateLimit.limiter, keyExtractor: '#userId' })(ManagementController);
  return ManagementController;
}
