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
   * Additional host authorization, evaluated after the authenticated-user check for session-protected
   * endpoints. Return false to reject with 403. Use it when the host has no PermissionsGuard that
   * enforces the permission metadata.
   */
  authorize?: (request: unknown, access: MonitoringAccess) => boolean | Promise<boolean>;
}

export const MONITORING_MODULE_OPTIONS = Symbol('MONITORING_MODULE_OPTIONS');
export const MONITORING_ACCESS_KIND = 'zucker:monitoring:access';

interface AuthenticatedRequest {
  user?: { id?: unknown } | null;
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * Fails closed: the monitoring controllers are unusable unless the host's authentication has
 * populated `request.user` (and, when configured, `authorize` approves). Permission codes are
 * still enforced by the host's PermissionsGuard through the metadata above.
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
