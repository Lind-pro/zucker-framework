import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { CreditsService } from './credits.service';
import { CreditsController } from './credits.controller';
import { CreditsRuntime } from './credits.runtime';
import { QuotaController } from './quota.controller';
import { QuotaService } from './quota.service';
import { QuotaRuntime } from './quota.runtime';
import { QUOTA_OPTIONS, quotaOptionsFromEnvironment } from './quota.config';

@Module({ imports: [JobsModule], controllers: [CreditsController, QuotaController],
  providers: [CreditsService, CreditsRuntime, QuotaService, QuotaRuntime, { provide: QUOTA_OPTIONS, useFactory: () => quotaOptionsFromEnvironment(process.env) }],
  exports: [CreditsService, QuotaService] })
export class CreditsModule {}
