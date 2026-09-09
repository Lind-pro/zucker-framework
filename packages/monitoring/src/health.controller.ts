import { Controller, Get, Res, SetMetadata } from '@nestjs/common';
import { HealthCheckService, HealthStatus } from './health-check.service';
import { getProcessUptime } from './process-uptime';

/** 标记为公开端点，无需认证（与 @zucker-framework/auth 的 @Public() 相同 key） */
const Public = () => SetMetadata('zucker:auth:isPublic', true);

export const HEALTH_OPTIONS = Symbol('HEALTH_OPTIONS');

export interface HealthOptions {
  /** 自定义 /health 路径前缀，默认 'health' */
  prefix?: string;
}

/**
 * 健康检查控制器
 *
 * 提供以下端点：
 * - GET /health       — 完整健康检查
 * - GET /health/live  — K8s liveness 探针（仅检查进程存活）
 * - GET /health/ready — K8s readiness 探针（检查所有依赖）
 */
@Controller('health')
@Public()
export class HealthController {
  private readonly startedAtMs = Date.now();

  constructor(private readonly healthCheckService: HealthCheckService) {}

  @Get()
  async check(@Res() res: any) {
    const result = await this.healthCheckService.checkAll();
    const statusCode = result.status === HealthStatus.DOWN ? 503 : 200;
    res.status(statusCode).json({
      status:
        result.status === HealthStatus.UP
          ? 'up'
          : result.status === HealthStatus.DEGRADED
            ? 'degraded'
            : 'down',
      checks: this.formatChecks(result.checks),
      ...getProcessUptime(this.startedAtMs),
      timestamp: result.timestamp.toISOString(),
    });
  }

  /**
   * K8s liveness 探针 — 仅检查进程是否存活
   */
  @Get('live')
  live(@Res() res: any) {
    res.status(200).json({
      status: 'up',
      ...getProcessUptime(this.startedAtMs),
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * K8s readiness 探针 — 检查所有依赖是否就绪
   */
  @Get('ready')
  async ready(@Res() res: any) {
    const result = await this.healthCheckService.checkAll();
    const isReady = result.status !== HealthStatus.DOWN;
    const statusCode = isReady ? 200 : 503;
    res.status(statusCode).json({
      status: isReady ? 'up' : 'down',
      checks: this.formatChecks(result.checks),
      ...getProcessUptime(this.startedAtMs),
      timestamp: result.timestamp.toISOString(),
    });
  }

  private formatChecks(
    checks: Array<{
      name: string;
      status: HealthStatus;
      details: Record<string, unknown>;
      timestamp: Date;
    }>,
  ): Record<string, { status: string; details: Record<string, unknown> }> {
    const formatted: Record<string, { status: string; details: Record<string, unknown> }> = {};
    for (const check of checks) {
      formatted[check.name] = {
        status:
          check.status === HealthStatus.UP
            ? 'up'
            : check.status === HealthStatus.DEGRADED
              ? 'degraded'
              : 'down',
        details: check.details,
      };
    }
    return formatted;
  }
}
