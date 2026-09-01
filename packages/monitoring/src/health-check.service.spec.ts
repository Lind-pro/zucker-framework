import { HealthCheckService, HealthStatus, type HealthIndicator } from './health-check.service';

describe('HealthCheckService', () => {
  it('does not expose an indicator exception message in public details', async () => {
    const service = new HealthCheckService();
    const indicator: HealthIndicator = {
      name: 'database',
      check: async () => {
        throw new Error('password=secret host=private-database');
      },
    };
    service.registerIndicator(indicator);

    await expect(service.checkAll()).resolves.toMatchObject({
      status: HealthStatus.DOWN,
      checks: [
        {
          name: 'database',
          status: HealthStatus.DOWN,
          details: { error: 'Health check failed' },
        },
      ],
    });
  });
});
