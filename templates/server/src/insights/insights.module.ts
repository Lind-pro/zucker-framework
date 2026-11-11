import { Module } from '@nestjs/common';
import { InsightsController } from './insights.controller';
import { InsightsService } from './insights.service';

/**
 * `/management/insights` (permission `insights:query`). Needs the CRUD database adapter and the
 * `api-default` rate limiter. No tables of its own; metrics whose tables are absent report
 * `{ available: false }`.
 */
@Module({ controllers: [InsightsController], providers: [InsightsService], exports: [InsightsService] })
export class InsightsModule {}
