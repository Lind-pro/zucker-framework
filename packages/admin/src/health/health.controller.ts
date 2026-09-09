/**
 * Health controller — lightweight liveness check for the admin Dashboard.
 *
 * Endpoints:
 * - GET /health  — returns { status, timestamp, uptime } (no auth required)
 */
import { Controller, Get } from '@nestjs/common';
import { Public } from '@zucker-framework/auth';

interface HealthResponse {
  status: 'ok';
  timestamp: string;
  /** Process uptime in seconds */
  uptime: number;
}

@Controller('health')
@Public()
export class HealthController {
  @Get()
  check(): HealthResponse {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  }
}
