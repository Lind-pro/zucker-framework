import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/**
 * ZuckerHealthModule
 *
 * Provides a lightweight GET /health liveness endpoint with no auth required.
 */
@Module({
  controllers: [HealthController],
})
export class ZuckerHealthModule {}
