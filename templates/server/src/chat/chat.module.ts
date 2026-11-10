import { Module } from '@nestjs/common';
import { AIConnectionsModule, AI_CONNECTION_ENVIRONMENT } from '../ai-connections/ai-connections.module';
import { AITasksModule } from '../ai-tasks/ai-tasks.module';
import { JobsModule } from '../jobs/jobs.module';
import { ChatController, ChatsManagementController } from './chat.controller';
import { CHAT_OPTIONS, ChatService, chatOptionsFromEnvironment } from './chat.service';

/** Metered streaming chat (`/chat*`) and the read-only `/management/chats` projection. */
@Module({
  imports: [AIConnectionsModule, AITasksModule, JobsModule],
  controllers: [ChatController, ChatsManagementController],
  providers: [ChatService,
    { provide: CHAT_OPTIONS, inject: [AI_CONNECTION_ENVIRONMENT], useFactory: (env: Readonly<Record<string, string | undefined>>) => chatOptionsFromEnvironment(env) }],
  exports: [ChatService],
})
export class ChatModule {}
