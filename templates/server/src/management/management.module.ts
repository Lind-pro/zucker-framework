import { Module } from '@nestjs/common';
import { CreditsModule } from '../credits/credits.module';
import { ManagementController } from './management.controller';
import { ManagementService } from './management.service';
import { ConnectionsService, MANAGEMENT_CONNECTION_ENV } from './connections.service';
import { RUNTIME_ENVIRONMENT } from '../runtime-settings';
@Module({
  imports: [CreditsModule],
  controllers: [ManagementController],
  providers: [
    ManagementService,
    ConnectionsService,
    {
      provide: MANAGEMENT_CONNECTION_ENV,
      inject: [{ token: RUNTIME_ENVIRONMENT, optional: true }],
      useFactory: (environment?: Readonly<NodeJS.ProcessEnv>) =>
        environment ?? Object.freeze({ ...process.env }),
    },
  ],
})
export class ManagementModule {}
