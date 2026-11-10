import { Module } from '@nestjs/common';
import { AccountModule } from '../accounts/account.module';
import { AIConnectionsModule, AI_CONNECTION_ENVIRONMENT } from '../ai-connections/ai-connections.module';
import { FilesModule } from '../files/files.module';
import { FILES_OPTIONS, filesOptionsFromEnvironment } from '../files/files.config';
import { FILES_TRANSFER_OPTIONS, filesTransferOptionsFromEnvironment } from '../files/files-transfer.config';
import { FilesDownloadService } from '../files/files-download.service';
import { JobsModule } from '../jobs/jobs.module';
import { AICatalogService } from './ai-catalog.service';
import { AITasksApiKeyController, AITasksController } from './ai-tasks.controller';
import { AITasksManagementController } from './ai-tasks.management';
import { AI_TASKS_OPTIONS, AITasksService, aiTasksOptionsFromEnvironment } from './ai-tasks.service';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * AI media generation: `/ai/catalog`, `/ai/tasks*`, `/v1/ai/tasks*` (API key scope `ai:generate`) and
 * `/management/ai-tasks`. Needs `PolicyModule` with `AI_POLICIES`, the AI connection module, the one
 * Jobs host and the private file service. Download tickets are issued by the same
 * `FilesDownloadService` (same JWT audience) and redeemed at `/api/files/:id/download`.
 */
@Module({
  imports: [AccountModule, AIConnectionsModule, FilesModule, JobsModule],
  controllers: [AITasksController, AITasksApiKeyController, AITasksManagementController],
  providers: [
    AICatalogService, AITasksService, FilesDownloadService,
    { provide: FILES_OPTIONS, inject: [AI_CONNECTION_ENVIRONMENT], useFactory: (env: Env) => filesOptionsFromEnvironment(env as NodeJS.ProcessEnv) },
    { provide: FILES_TRANSFER_OPTIONS, inject: [AI_CONNECTION_ENVIRONMENT], useFactory: (env: Env) => filesTransferOptionsFromEnvironment(env as NodeJS.ProcessEnv) },
    { provide: AI_TASKS_OPTIONS, inject: [AI_CONNECTION_ENVIRONMENT], useFactory: (env: Env) => aiTasksOptionsFromEnvironment(env) },
  ],
  exports: [AICatalogService, AITasksService],
})
export class AITasksModule {}
