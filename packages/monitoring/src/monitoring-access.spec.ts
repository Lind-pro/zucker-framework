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
    expect(ZuckerMonitoringModule.forRoot({ metrics: true, alerts: true }).controllers).toEqual([
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
});
