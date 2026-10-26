import { Module } from '@nestjs/common';
import { AccountModule } from '../accounts/account.module';
import { RUNTIME_ENVIRONMENT } from '../runtime-settings/runtime-settings.tokens';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { FILES_OPTIONS, filesOptionsFromEnvironment } from './files.config';
import { FILES_IMPORT_FETCH, FILES_TRANSFER_OPTIONS, filesTransferOptionsFromEnvironment } from './files-transfer.config';
import { FilesDownloadService } from './files-download.service';
import { FileDownloadPrivacyGuard, FilesDownloadController } from './files-download.controller';
import { FilesImportService } from './files-import.service';
/** FILE_MANAGER is configured once at the composition root. Object IO is outside metadata transactions. */
@Module({
  imports: [AccountModule],
  controllers: [FilesController, FilesDownloadController],
  providers: [
    { provide: FILES_OPTIONS, inject: [{ token: RUNTIME_ENVIRONMENT, optional: true }], useFactory: (env?: Readonly<NodeJS.ProcessEnv>) => filesOptionsFromEnvironment(env ?? process.env) },
    { provide: FILES_TRANSFER_OPTIONS, inject: [{ token: RUNTIME_ENVIRONMENT, optional: true }], useFactory: (env?: Readonly<NodeJS.ProcessEnv>) => filesTransferOptionsFromEnvironment(env ?? process.env) },
    { provide: FILES_IMPORT_FETCH, useValue: (url: string, options: RequestInit) => fetch(url, options) },
    FilesService, FilesDownloadService, FilesImportService, FileDownloadPrivacyGuard,
  ],
  exports: [FilesService],
})
export class FilesModule {}
