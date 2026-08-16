import { Injectable, Logger } from '@nestjs/common';

export enum HealthStatus {
  UP = 'UP',
  DOWN = 'DOWN',
  DEGRADED = 'DEGRADED',
}

export interface HealthCheck {
  name: string;
  status: HealthStatus;
  details: Record<string, unknown>;
  timestamp: Date;
}

export interface HealthIndicator {
  name: string;
  check(): Promise<HealthCheck>;
}

@Injectable()
export class HealthCheckService {
  private readonly logger = new Logger(HealthCheckService.name);
  private indicators: HealthIndicator[] = [];

  registerIndicator(indicator: HealthIndicator): void {
    this.indicators.push(indicator);
    this.logger.log(`Health indicator registered: ${indicator.name}`);
  }

  unregisterIndicator(name: string): void {
    this.indicators = this.indicators.filter((i) => i.name !== name);
  }

  async checkAll(): Promise<{
    status: HealthStatus;
    checks: HealthCheck[];
    timestamp: Date;
  }> {
    const checks: HealthCheck[] = [];
    let overallStatus = HealthStatus.UP;

    for (const indicator of this.indicators) {
      try {
        const result = await indicator.check();
        checks.push(result);

        if (result.status === HealthStatus.DOWN) {
          overallStatus = HealthStatus.DOWN;
        } else if (result.status === HealthStatus.DEGRADED && overallStatus !== HealthStatus.DOWN) {
          overallStatus = HealthStatus.DEGRADED;
        }
      } catch (error) {
        const errorType = error instanceof Error ? error.name : 'UnknownError';
        this.logger.warn(`Health indicator failed: ${indicator.name} (${errorType})`);
        checks.push({
          name: indicator.name,
          status: HealthStatus.DOWN,
          details: { error: 'Health check failed' },
          timestamp: new Date(),
        });
        overallStatus = HealthStatus.DOWN;
      }
    }

    return { status: overallStatus, checks, timestamp: new Date() };
  }

  async check(name: string): Promise<HealthCheck | undefined> {
    const indicator = this.indicators.find((i) => i.name === name);
    if (!indicator) return undefined;
    return indicator.check();
  }
}
