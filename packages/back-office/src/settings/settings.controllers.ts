import {
  Body, Controller, ForbiddenException, Get, Header, HttpException, Inject, Param, Put, Req, ServiceUnavailableException, UseGuards,
  type CanActivate, type Type,
} from '@nestjs/common';
import { JwtAuthGuard, Permissions, PermissionsGuard, Public } from '@zucker-framework/auth';
import type { DatabaseAdapter } from '@zucker-framework/core';
import { RateLimit, RateLimitGuard } from '@zucker-framework/rate-limiter';
import type { ConnectionSettingsService } from './connection-settings.service';
import type { PolicyService } from './policy.service';
import type { ResolvedSettingsOptions } from './settings.options';
import { SETTINGS_CONNECTIONS, SETTINGS_POLICIES } from './settings.tokens';

interface SettingsRequest { user: { id: string }; headers: Record<string, string | string[] | undefined> }
type Method = (...args: never[]) => unknown;

/** Which settings route a generated controller class serves (see `settingsController`). */
export type SettingsControllerKind = 'connections' | 'integrations' | 'policies' | 'site-config';
export const SETTINGS_CONTROLLER_KIND = Symbol.for('zucker:back-office:settings:controllerKind');

function route(prototype: object, name: string, decorators: MethodDecorator[], parameters: Array<() => ParameterDecorator> = []) {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, name)!;
  parameters.forEach((decorator, index) => decorator()(prototype, name, index));
  for (const decorator of [...decorators].reverse()) decorator(prototype, name, descriptor);
  Object.defineProperty(prototype, name, descriptor);
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** State change from a browser: exact trusted Origin, never a cross-site fetch. */
function assertTrustedOrigin(origins: ReadonlySet<string>, request: SettingsRequest, message: string): void {
  if (typeof request.headers.origin !== 'string' || !origins.has(request.headers.origin) || request.headers['sec-fetch-site'] === 'cross-site')
    throw new ForbiddenException(message);
}
async function result<T>(work: () => Promise<T>, message: string): Promise<T> {
  try { return await work(); } catch (error) {
    if (error instanceof HttpException) throw error;
    throw new ServiceUnavailableException(message);
  }
}
function administrator(options: ResolvedSettingsOptions, target: Type<unknown>, path: string, kind: SettingsControllerKind) {
  const guards: Type<CanActivate>[] = [...(options.guards ?? [JwtAuthGuard, PermissionsGuard]), ...(options.rateLimit ? [RateLimitGuard] : [])];
  Controller(path)(target);
  if (guards.length) UseGuards(...guards)(target);
  if (options.rateLimit) RateLimit({ limiter: options.rateLimit.limiter, keyExtractor: '#userId' })(target);
  Object.defineProperty(target, SETTINGS_CONTROLLER_KIND, { value: kind });
}
function publicController(target: Type<unknown>, path: string, kind: SettingsControllerKind) {
  Controller(path)(target); Public()(target); Permissions()(target);
  Object.defineProperty(target, SETTINGS_CONTROLLER_KIND, { value: kind });
}

/**
 * `GET <path>/connection-settings`, `GET|PUT <path>/connection-settings/:profileId`. Reads need the query
 * permission, writes the update permission and a trusted Origin; every response is `private, no-store`.
 */
export function createConnectionSettingsController(options: ResolvedSettingsOptions): Type<unknown> {
  const guards = options.connections ? options.connections.saveGuards : [];
  class ConnectionSettingsController {
    readonly origins: ReadonlySet<string>;
    constructor(@Inject(SETTINGS_CONNECTIONS) readonly settings: ConnectionSettingsService, @Inject(options.database) readonly database: DatabaseAdapter) {
      this.origins = new Set(options.trustedOrigins().map(value => value.trim()).filter(Boolean));
    }
    list() { return result(() => this.settings.list(), 'Connection configuration could not be saved or loaded'); }
    get(id: string) { return result(() => this.settings.get(id), 'Connection configuration could not be saved or loaded'); }
    save(request: SettingsRequest, id: string, body: unknown) {
      assertTrustedOrigin(this.origins, request, 'Untrusted connection update origin');
      return result(async () => {
        const guard = guards.find(row => row.profileId === id);
        if (!guard || !record(body)) return this.settings.save(request.user.id, id, body);
        const checked = await guard.check({ profileId: id, actorId: request.user.id, body, settings: this.settings, database: this.database });
        const save = () => this.settings.save(request.user.id, id, checked.body);
        return checked.audit ? this.settings.withSaveAudit(checked.audit, save) : save();
      }, 'Connection configuration could not be saved or loaded');
    }
  }
  const prototype = ConnectionSettingsController.prototype as unknown as Record<string, Method>;
  const noStore = Header('Cache-Control', 'private, no-store');
  route(prototype, 'list', [Get(), Permissions(options.permissions.query), noStore]);
  route(prototype, 'get', [Get(':profileId'), Permissions(options.permissions.query), noStore], [() => Param('profileId')]);
  route(prototype, 'save', [Put(':profileId'), Permissions(options.permissions.update), noStore], [() => Req(), () => Param('profileId'), () => Body()]);
  administrator(options, ConnectionSettingsController, `${options.path}/connection-settings`, 'connections');
  return ConnectionSettingsController;
}

/** `GET <publicPath>/integrations`: unauthenticated, `no-store` projection of the applied public profiles. */
export function createSiteIntegrationsController(options: ResolvedSettingsOptions): Type<unknown> {
  class SiteIntegrationsController {
    constructor(@Inject(SETTINGS_CONNECTIONS) readonly settings: ConnectionSettingsService) {}
    async integrations() {
      try { return await this.settings.publicIntegrations(); }
      catch { throw new ServiceUnavailableException('Applied public website configuration is unavailable'); }
    }
  }
  route(SiteIntegrationsController.prototype, 'integrations', [Get('integrations'), Header('Cache-Control', 'no-store')]);
  publicController(SiteIntegrationsController, options.publicPath, 'integrations');
  return SiteIntegrationsController;
}

/** `GET <path>/policies`, `GET|PUT <path>/policies/:policyId`: same permission, Origin and rate-limit contract as connection settings. */
export function createPolicyController(options: ResolvedSettingsOptions): Type<unknown> {
  class PolicyController {
    readonly origins: ReadonlySet<string>;
    constructor(@Inject(SETTINGS_POLICIES) readonly policies: PolicyService) {
      this.origins = new Set(options.trustedOrigins().map(value => value.trim()).filter(Boolean));
    }
    list() { return result(() => this.policies.list(), 'Policy configuration could not be saved or loaded'); }
    get(id: string) { return result(() => this.policies.view(id), 'Policy configuration could not be saved or loaded'); }
    save(request: SettingsRequest, id: string, body: unknown) {
      assertTrustedOrigin(this.origins, request, 'Untrusted policy update origin');
      return result(() => this.policies.save(request.user.id, id, body), 'Policy configuration could not be saved or loaded');
    }
  }
  const prototype = PolicyController.prototype as unknown as Record<string, Method>;
  const noStore = Header('Cache-Control', 'private, no-store');
  route(prototype, 'list', [Get(), Permissions(options.permissions.query), noStore]);
  route(prototype, 'get', [Get(':policyId'), Permissions(options.permissions.query), noStore], [() => Param('policyId')]);
  route(prototype, 'save', [Put(':policyId'), Permissions(options.permissions.update), noStore], [() => Req(), () => Param('policyId'), () => Body()]);
  administrator(options, PolicyController, `${options.path}/policies`, 'policies');
  return PolicyController;
}

/**
 * `GET <publicPath>/config`: unauthenticated projection of `public: true` policy fields only,
 * `{policies: {[id]: {revision, values}}}`. No selector parameters; served from the per-process policy cache.
 */
export function createSiteConfigController(options: ResolvedSettingsOptions): Type<unknown> {
  class SiteConfigController {
    constructor(@Inject(SETTINGS_POLICIES) readonly policies: PolicyService) {}
    async config() {
      try { return await this.policies.publicConfig(); }
      catch { throw new ServiceUnavailableException('Public site configuration is unavailable'); }
    }
  }
  route(SiteConfigController.prototype, 'config', [Get('config'), Header('Cache-Control', 'no-store')]);
  publicController(SiteConfigController, options.publicPath, 'site-config');
  return SiteConfigController;
}
