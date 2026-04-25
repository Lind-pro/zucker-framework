import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';

/**
 * ZuckerDashboardAdminModule
 *
 * Provides GET /dashboard/stats — a fallback aggregate stats endpoint.
 * The admin frontend primarily uses individual _count endpoints on each
 * feature module; this module acts as a unified summary fallback.
 */
@Module({
  controllers: [DashboardController],
})
export class ZuckerDashboardAdminModule {}
