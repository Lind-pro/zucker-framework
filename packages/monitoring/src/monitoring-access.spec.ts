// @vitest-environment node
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { ZuckerMonitoringModule } from './monitoring.module';
import { HealthController } from './health.controller';
import { AlertManagerService } from './alert/alert-manager.service';
import { AlertController, parseAlertRule } from './alert/alert.controller';
import { PrometheusExporter, TokenPrometheusExporter } from './metrics/prometheus-exporter';
import { MetricsTokenGuard, MonitoringAccessGuard, type MonitoringModuleOptions } from './monitoring-access';

const TOKEN = 'x'.repeat(40);

function context(
  request: Record<string, unknown>,
  controller: abstract new (...args: never[]) => unknown,
  handler: string,
): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getClass: () => controller,
    getHandler: () => (controller.prototype as Record<string, unknown>)[handler],
  } as unknown as ExecutionContext;
}

describe('monitoring endpoint exposure', () => {
  it('mounts only /health when the module is imported without options', () => {
    expect(Reflect.getMetadata('controllers', ZuckerMonitoringModule)).toEqual([HealthController]);
    expect(ZuckerMonitoringModule.forRoot().controllers).toEqual([]);
  });

  it('mounts metrics and alerts only when opted in', () => {
    expect(ZuckerMonitoringModule.forRoot({ metrics: true, alerts: true, permissions: 'host-guard' }).controllers).toEqual([
      PrometheusExporter,
      AlertController,
    ]);
    expect(ZuckerMonitoringModule.forRoot({ metrics: { token: TOKEN } }).controllers).toEqual([TokenPrometheusExporter]);
    expect(() => ZuckerMonitoringModule.forRoot({ metrics: { token: 'short' } })).toThrow('at least 32');
  });

  it('declares guards and permission metadata on the session-protected controllers', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AlertController)).toEqual([MonitoringAccessGuard]);
    expect(Reflect.getMetadata(GUARDS_METADATA, PrometheusExporter)).toEqual([MonitoringAccessGuard]);
    expect(Reflect.getMetadata('zucker:auth:permissions', AlertController)).toEqual(['monitoring:query']);
    expect(Reflect.getMetadata('zucker:auth:permissions', AlertController.prototype.createRule)).toEqual([
      'monitoring:update',
    ]);
    expect(Reflect.getMetadata('zucker:auth:permissions', PrometheusExporter)).toEqual(['monitoring:query']);
    expect(Reflect.getMetadata('zucker:auth:isPublic', TokenPrometheusExporter)).toBe(true);
  });

  it('fails closed without an authenticated user and applies authorize()', async () => {
    const options: MonitoringModuleOptions = {
      authorize: (request, access) =>
        access !== 'alerts:write' || (request as { user: { id: string } }).user.id === 'admin',
    };
    const guard = new MonitoringAccessGuard(new Reflector(), options);
    await expect(guard.canActivate(context({}, AlertController, 'getAlerts'))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(
      guard.canActivate(context({ user: { id: 'member' } }, AlertController, 'getAlerts')),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(context({ user: { id: 'member' } }, AlertController, 'createRule')),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      guard.canActivate(context({ user: { id: 'admin' } }, AlertController, 'createRule')),
    ).resolves.toBe(true);
    await expect(
      new MonitoringAccessGuard(new Reflector()).canActivate(context({}, PrometheusExporter, 'getMetrics')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('accepts only the configured scrape token', () => {
    const guard = new MetricsTokenGuard({ metrics: { token: TOKEN } });
    const check = (authorization?: string) =>
      guard.canActivate(context({ headers: { authorization } }, TokenPrometheusExporter, 'getMetrics'));
    expect(() => check()).toThrow(UnauthorizedException);
    expect(() => check('Bearer wrong')).toThrow(UnauthorizedException);
    expect(check(`Bearer ${TOKEN}`)).toBe(true);
    expect(() => new MetricsTokenGuard({}).canActivate(context({ headers: {} }, TokenPrometheusExporter, 'getMetrics'))).toThrow(
      UnauthorizedException,
    );
  });

  it('records the authenticated actor and ignores a body-supplied userId', () => {
    const manager = new AlertManagerService();
    const controller = new AlertController(manager);
    controller.createRule({ id: 'cpu', name: 'CPU', metric: 'cpu', threshold: 1 });
    const [alert] = manager.evaluate({ cpu: 5 });
    expect(controller.acknowledgeAlert(alert.id, { user: { id: 'admin' } }).acknowledgedBy).toBe('admin');
    expect(() => controller.resolveAlert(alert.id, {})).toThrow(UnauthorizedException);
  });

  it('deletes a removed rule from the database', async () => {
    const deleted: unknown[] = [];
    const db = { model: () => ({ delete: async (args: unknown) => void deleted.push(args) }) };
    const manager = new AlertManagerService(undefined, db);
    manager['rules'].set('r', { id: 'r' } as never);
    expect(manager.removeRule('r')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deleted).toEqual([{ where: { id: 'r' } }]);
  });

  it('validates alert rule bodies', () => {
    expect(() => parseAlertRule({ id: '../x', name: 'n', metric: 'm', threshold: 1 })).toThrow();
    expect(() => parseAlertRule({ id: 'a', name: 'n', metric: 'm', threshold: '1' })).toThrow();
    expect(() => parseAlertRule({ id: 'a', name: 'n', metric: 'm', threshold: 1, condition: 'eval' })).toThrow();
    expect(parseAlertRule({ id: 'a', name: ' n ', metric: 'm', threshold: 1, extra: 'dropped' })).toEqual({
      id: 'a',
      name: 'n',
      metric: 'm',
      condition: '>',
      threshold: 1,
      duration: 0,
      severity: 'MEDIUM',
      enabled: true,
      notifyChannels: undefined,
    });
  });

  describe('route protection requires an explicit authorization story', () => {
    const routeHandlers = Object.getOwnPropertyNames(AlertController.prototype).filter(
      (name) => name !== 'constructor' && typeof Reflect.getMetadata('method', AlertController.prototype[name as keyof AlertController]) === 'number',
    );

    it('refuses alerts: true or metrics: true without authorize or permissions', () => {
      expect(() => ZuckerMonitoringModule.forRoot({ alerts: true })).toThrow(/authorize|host-guard/);
      expect(() => ZuckerMonitoringModule.forRoot({ metrics: true })).toThrow(/authorize|host-guard/);
      expect(() => ZuckerMonitoringModule.forRoot({ alerts: true, metrics: true })).toThrow();
    });

    it('accepts either authorize or permissions: host-guard', () => {
      expect(ZuckerMonitoringModule.forRoot({ alerts: true, authorize: () => true }).controllers).toEqual([AlertController]);
      expect(ZuckerMonitoringModule.forRoot({ metrics: true, permissions: 'host-guard' }).controllers).toEqual([
        PrometheusExporter,
      ]);
    });

    it('returns 403 on every alert route when authorize denies an authenticated user', async () => {
      expect(routeHandlers.length).toBeGreaterThanOrEqual(6);
      const guard = new MonitoringAccessGuard(new Reflector(), { authorize: () => false });
      for (const handler of routeHandlers) {
        await expect(
          guard.canActivate(context({ user: { id: 'member' } }, AlertController, handler)),
        ).rejects.toBeInstanceOf(ForbiddenException);
      }
    });

    it("passes 'alerts:read' for GET and 'alerts:write' for POST/PUT/DELETE", async () => {
      const seen: Array<[string, string]> = [];
      const guard = new MonitoringAccessGuard(new Reflector(), {
        authorize: (_request, access) => {
          seen.push([currentHandler, access]);
          return true;
        },
      });
      let currentHandler = '';
      const GET = 0;
      for (const handler of routeHandlers) {
        currentHandler = handler;
        await guard.canActivate(context({ user: { id: 'u' } }, AlertController, handler));
      }
      for (const [handler, access] of seen) {
        const method = Reflect.getMetadata('method', AlertController.prototype[handler as keyof AlertController]);
        expect(access, handler).toBe(method === GET ? 'alerts:read' : 'alerts:write');
      }
      expect(seen.some(([, access]) => access === 'alerts:read')).toBe(true);
      expect(seen.some(([, access]) => access === 'alerts:write')).toBe(true);
    });

    it('passes the metrics access kind for the metrics exporter', async () => {
      const seen: string[] = [];
      const guard = new MonitoringAccessGuard(new Reflector(), {
        authorize: (_request, access) => {
          seen.push(access);
          return true;
        },
      });
      await guard.canActivate(context({ user: { id: 'u' } }, PrometheusExporter, 'getMetrics'));
      expect(seen).toEqual(['metrics']);
    });

    it('keeps the metrics token path unchanged', () => {
      const guard = new MetricsTokenGuard({ metrics: { token: TOKEN } });
      const check = (authorization?: string) =>
        guard.canActivate(context({ headers: { authorization } }, TokenPrometheusExporter, 'getMetrics'));
      expect(() => check('Bearer wrong')).toThrow(UnauthorizedException);
      expect(check(`Bearer ${TOKEN}`)).toBe(true);
      expect(() => ZuckerMonitoringModule.forRoot({ metrics: { token: 'x'.repeat(31) } })).toThrow('at least 32');
      expect(ZuckerMonitoringModule.forRoot({ metrics: { token: 'x'.repeat(32) } }).controllers).toEqual([
        TokenPrometheusExporter,
      ]);
    });
  });
});
