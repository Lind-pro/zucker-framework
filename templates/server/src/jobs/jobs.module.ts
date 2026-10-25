import { Global, Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { JobsService } from './jobs.service';
import { JobsHost } from './jobs.host';
import { JobsController } from './jobs.controller';
import { DefaultJobHandlers } from './jobs.handlers';
import { JOBS_OPTIONS, jobsOptionsFromEnvironment } from './jobs.config';

/** Register once at the root. Consumer providers register extensions during onModuleInit. */
@Global()
@Module({ imports: [FilesModule, DeliveryModule], controllers: [JobsController],
  providers: [JobsService, DefaultJobHandlers, JobsHost, { provide: JOBS_OPTIONS, useFactory: () => jobsOptionsFromEnvironment(process.env) }],
  exports: [JobsService, JobsHost, DeliveryModule] })
export class JobsModule {}
