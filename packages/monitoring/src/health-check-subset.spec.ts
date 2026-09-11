import { expect, it, vi } from 'vitest';
import { HealthCheckService, HealthStatus } from './health-check.service';
it('selects readiness probes without running diagnostic-only checks', async () => {
  const service = new HealthCheckService();
  const diagnostic = vi.fn();
  service.registerIndicator({
    name: 'database',
    check: async () => ({
      name: 'database',
      status: HealthStatus.UP,
      details: {},
      timestamp: new Date(),
    }),
  });
  service.registerIndicator({ name: 'diagnostic', check: diagnostic });
  const result = await service.checkAll(['database']);
  expect(result.status).toBe(HealthStatus.UP);
  expect(result.checks.map((check) => check.name)).toEqual(['database']);
  expect(diagnostic).not.toHaveBeenCalled();
});
it('does not report ready when a requested probe was never registered', async () => {
  const service = new HealthCheckService();
  const result = await service.checkAll(['database']);
  expect(result.status).toBe(HealthStatus.DOWN);
  expect(result.checks[0]).toMatchObject({ name: 'database', status: HealthStatus.DOWN });
});
