import { createHash, timingSafeEqual } from 'node:crypto';
import {
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  SetMetadata,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

/** Same metadata keys as @zucker-framework/auth (`@Permissions()` / `@Public()`); kept local to avoid the dependency. */
export const MONITORING_PERMISSIONS_METADATA = 'zucker:auth:permissions';
export const MONITORING_PUBLIC_METADATA = 'zucker:auth:isPublic';

/** Permission code required to read metrics, alerts and alert rules. */
export const MONITORING_QUERY_PERMISSION = 'monitoring:query';
/** Permission code required to change alert rules and acknowledge/resolve alerts. */
export const MONITORING_UPDATE_PERMISSION = 'monitoring:update';

export const MonitoringPermissions = (...codes: string[]) =>
  SetMetadata(MONITORING_PERMISSIONS_METADATA, codes);

export type MonitoringAccess = 'metrics' | 'alerts:read' | 'alerts:write';

export interface MonitoringModuleOptions {
  /**
   * Mount `GET /metrics`. Default false.
   * - `true`: requires an authenticated `request.user` and carries `monitoring:query` permission metadata
   *   for the host's PermissionsGuard.
   * - `{ token }`: marked public for the host's auth guards and protected by
   *   `Authorization: Bearer <token>` instead (for Prometheus scrapers). The token must be at least 32 characters.
   */
  metrics?: boolean | { token: string };
  /**
   * Mount the `/monitoring/alerts` API. Default false. Requires an authenticated `request.user`;
   * reads carry `monitoring:query` and writes `monitoring:update` permission metadata.
   */
  alerts?: boolean;
  /**
   * Host authorization for the session-protected endpoints, evaluated after the
   * authenticated-user check. Return anything but `true` to reject with 403. `access` is
   * `'metrics'`, `'alerts:read'` (GET) or `'alerts:write'` (POST/PUT/DELETE).
   */
  authorize?: (request: unknown, access: MonitoringAccess) => boolean | Promise<boolean>;
  /**
   * `'host-guard'` asserts that the host registers a global (`APP_GUARD`) permissions guard that
   * enforces the `monitoring:query` / `monitoring:update` metadata on these controllers.
   * `forRoot` refuses `metrics: true` or `alerts: true` unless this or `authorize` is given,
   * because the module's own guard only checks for a signed-in user.
   */
  permissions?: 'host-guard';
}

export const MONITORING_MODULE_OPTIONS = Symbol('MONITORING_MODULE_OPTIONS');
export const MONITORING_ACCESS_KIND = 'zucker:monitoring:access';

interface AuthenticatedRequest {
  user?: { id?: unknown } | null;
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * Rejects anonymous callers (401) and, when configured, callers that `authorize` refuses (403).
 * On its own it does NOT check permissions: any signed-in user passes. Permission codes are
 * enforced only by a host permissions guard reading the metadata above, which is why `forRoot`
 * requires `authorize` or `permissions: 'host-guard'`. The host's authentication must run
 * before this guard (a global guard); a controller-level auth guard elsewhere never sets
 * `request.user` here, so every call would return 401.
 */
@Injectable()
export class MonitoringAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Optional() @Inject(MONITORING_MODULE_OPTIONS) private readonly options: MonitoringModuleOptions = {},
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const id = request.user?.id;
    if (id === undefined || id === null || id === '') {
      throw new UnauthorizedException('Authentication required');
    }
    if (this.options.authorize) {
      const access =
        this.reflector.getAllAndOverride<MonitoringAccess | undefined>(MONITORING_ACCESS_KIND, [
          context.getHandler(),
          context.getClass(),
        ]) ?? 'alerts:write';
      if ((await this.options.authorize(request, access)) !== true) {
        throw new ForbiddenException('Monitoring access denied');
      }
    }
    return true;
  }
}

/** Bearer-token check for the public scrape endpoint (constant-time comparison). */
@Injectable()
export class MetricsTokenGuard implements CanActivate {
  private readonly expected?: Buffer;

  constructor(
    @Optional() @Inject(MONITORING_MODULE_OPTIONS) options: MonitoringModuleOptions = {},
  ) {
    const token = typeof options.metrics === 'object' ? options.metrics.token : undefined;
    this.expected = token ? digest(token) : undefined;
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.expected) throw new UnauthorizedException('Metrics token not configured');
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers?.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    const match = typeof value === 'string' ? /^Bearer\s+(\S+)$/i.exec(value.trim()) : null;
    if (!match || !timingSafeEqual(digest(match[1]), this.expected)) {
      throw new UnauthorizedException('Invalid metrics token');
    }
    return true;
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
