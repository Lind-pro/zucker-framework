import {
  BadRequestException, ConflictException, Global, Inject, Injectable, Module, Optional, ServiceUnavailableException,
  type CallHandler, type ExecutionContext, type NestInterceptor, type OnModuleDestroy,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { createPublicFetch, DATABASE_ADAPTER } from '@zucker-framework/core';
import { FILE_MANAGER, type FileInfo, type FileManager, type StorageProviderType, type UploadOptions, type UploadResult } from '@zucker-framework/storage';
import type { Readable } from 'node:stream';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { AccountModule } from '../accounts/account.module';
import type { ApplicationDatabase } from '../database';
import { ConnectionSettingsController } from '../runtime-settings/connection-settings.controller';
import { ConnectionSettingsService } from '../runtime-settings/connection-settings.service';
import { HotProvider } from '@zucker-framework/back-office/settings';
import { RUNTIME_ENVIRONMENT } from '../runtime-settings/runtime-settings.tokens';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import {
  FILES_OPTIONS, fileManagerFromOptions, filesOptionsFromEnvironment, PRIVATE_FILES_CONNECTION_PROFILE, STORAGE_LOCATION_FIELDS,
  storageOptionsFromEnvironment,
} from './files.config';
import { FILES_IMPORT_FETCH, FILES_TRANSFER_OPTIONS, filesTransferOptionsFromEnvironment } from './files-transfer.config';
import { FilesDownloadService } from './files-download.service';
import { FileDownloadPrivacyGuard, FilesDownloadController } from './files-download.controller';
import { FilesImportService } from './files-import.service';
import { PublicAssetsController, PublicAssetsManagementController } from './public-assets.controller';
import { PublicAssetsService } from './public-assets.service';
import { FileOrphanSweeper } from './file-object-intents';
import { PUBLIC_ASSETS_OPTIONS, publicAssetsOptionsFromEnvironment } from './public-assets.config';

/** Hot provider of the object storage client built from the `private-files` profile. */
export const FILES_STORAGE = Symbol('FILES_STORAGE');
export type FilesStorage = HotProvider<FileManager>;

/**
 * The application's one `FILE_MANAGER`: every call goes to the storage client of the current
 * `private-files` revision and holds it until the call settles (a download until its stream closes),
 * so a replaced client (S3 sockets) is destroyed only after in-flight transfers finish. The two steps
 * of a multi-call operation (upload, then verify) may run on different revisions when a save lands in
 * between; for a credential change both reach the same objects, and a location change is an
 * acknowledged data move (D14). Synchronous members read the newest resolved client.
 */
export class HotFileManager implements FileManager, OnModuleDestroy {
  constructor(private readonly storage: FilesStorage) {}
  get providerType(): StorageProviderType { return this.storage.now().providerType; }
  isConfigured(): boolean { try { return this.storage.now().isConfigured(); } catch { return false; } }
  upload(buffer: Buffer, key: string, options?: UploadOptions): Promise<UploadResult> { return this.storage.use(manager => manager.upload(buffer, key, options)); }
  uploadStream(stream: Readable, key: string, options?: UploadOptions): Promise<UploadResult> { return this.storage.use(manager => manager.uploadStream(stream, key, options)); }
  download(key: string): Promise<{ stream: Readable; size: number }> {
    return new Promise((resolve, reject) => {
      this.storage.use(async manager => {
        const object = await manager.download(key);
        // Keep the client leased until the body stream is finished or destroyed.
        await new Promise<void>(release => { object.stream.once('close', release); resolve(object); });
      }).catch(reject);
    });
  }
  delete(key: string): Promise<void> { return this.storage.use(manager => manager.delete(key)); }
  exists(key: string): Promise<boolean> { return this.storage.use(manager => manager.exists(key)); }
  getPublicUrl(key: string): Promise<string> { return this.storage.use(manager => manager.getPublicUrl(key)); }
  getDownloadUrl(key: string, expiresIn?: number): Promise<string> { return this.storage.use(manager => manager.getDownloadUrl(key, expiresIn)); }
  list(prefix: string): Promise<FileInfo[]> { return this.storage.use(manager => manager.list(prefix)); }
  async onModuleDestroy(): Promise<void> { await this.storage.close(); }
}

/** Disposes a replaced storage client (S3 sockets); local and WebDAV clients hold nothing. */
function disposeFileManager(manager: FileManager): void {
  (manager as Partial<OnModuleDestroy>).onModuleDestroy?.();
}

/**
 * Global `FILE_MANAGER` over the hot `private-files` profile (replaces a one-shot
 * `ZuckerStorageModule.forRootAsync`). Start-up fails as before when the saved or environment storage
 * configuration cannot be assembled (for example local storage in production).
 */
@Global()
@Module({
  providers: [
    { provide: FILES_STORAGE, inject: [{ token: ConnectionSettingsService, optional: true }, { token: RUNTIME_ENVIRONMENT, optional: true }],
      useFactory: (settings?: ConnectionSettingsService, environment?: Readonly<NodeJS.ProcessEnv>) => HotProvider.create<FileManager>(settings, environment, {
        name: 'Private file storage', profiles: [PRIVATE_FILES_CONNECTION_PROFILE],
        build: env => fileManagerFromOptions(storageOptionsFromEnvironment(env as NodeJS.ProcessEnv)),
        dispose: disposeFileManager,
      }).ready() },
    { provide: FILE_MANAGER, inject: [FILES_STORAGE], useFactory: (storage: FilesStorage) => new HotFileManager(storage) },
  ],
  exports: [FILES_STORAGE, FILE_MANAGER],
})
export class PrivateStorageModule {}

interface LocationRequest {
  method?: string; params?: { profileId?: string }; body?: unknown; user?: { id?: string };
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const ACKNOWLEDGE = 'acknowledgeDataLocationChange';
/** Error code of the D14 refusal; the admin Connections page asks for confirmation and resends with the flag. */
export const DATA_LOCATION_CHANGE_CODE = 'DATA_LOCATION_CHANGE_UNACKNOWLEDGED';

/**
 * D14 storage-location guard on `PUT /management/connection-settings/private-files` (runs after the
 * authentication and permission guards). A save that changes the provider, endpoint or bucket while
 * file rows exist is refused with 409 unless the body carries `acknowledgeDataLocationChange: true`;
 * the flag is removed from the body before the generic connection update parser sees it. The check
 * compares against the revision the body names (`expectedRevision`); a stale body is left to the
 * save's own compare-and-swap. An acknowledged change is audited (`files` / `acknowledge-data-location-change`)
 * after the save commits. No object is moved.
 */
@Injectable()
export class StorageLocationGuard implements NestInterceptor {
  constructor(@Inject(DATABASE_ADAPTER) private readonly database: ApplicationDatabase,
    @Optional() private readonly settings?: ConnectionSettingsService) {}
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> | Promise<Observable<unknown>> {
    if (context.getType() !== 'http' || context.getClass() !== ConnectionSettingsController) return next.handle();
    const request = context.switchToHttp().getRequest<LocationRequest>();
    if (request.method !== 'PUT' || request.params?.profileId !== PRIVATE_FILES_CONNECTION_PROFILE || !record(request.body) || !this.settings) return next.handle();
    return this.guard(request, request.body, this.settings, next);
  }
  private async guard(request: LocationRequest, body: Record<string, unknown>, settings: ConnectionSettingsService, next: CallHandler): Promise<Observable<unknown>> {
    const acknowledged = body[ACKNOWLEDGE];
    if (acknowledged !== undefined && typeof acknowledged !== 'boolean') throw new BadRequestException('Invalid connection update');
    const { [ACKNOWLEDGE]: _flag, ...rest } = body;
    request.body = rest;
    const current = await settings.get(PRIVATE_FILES_CONNECTION_PROFILE);
    const values = rest.values;
    if (rest.expectedRevision !== current.storedRevision || (values !== undefined && !record(values))) return next.handle();
    const changed = STORAGE_LOCATION_FIELDS.filter(key => {
      const field = current.fields.find(row => row.key === key);
      if (!field || !values || !Object.hasOwn(values, key)) return false;
      const submitted = values[key];
      if (submitted !== null && typeof submitted !== 'string') return false; // the parser rejects it
      const candidate = submitted === null ? field.defaultValue ?? '' : submitted.trim();
      return candidate !== ((field as { value?: string | null }).value ?? '').trim();
    });
    if (!changed.length) return next.handle();
    let rows: number;
    try {
      rows = await this.database.model('fileAssets').count({}) as number;
      if (!rows) rows = await this.database.model('publicAssets').count({}) as number;
    } catch { throw new ServiceUnavailableException('Stored files could not be counted'); }
    if (!rows) return next.handle();
    if (acknowledged !== true) throw new ConflictException({ code: DATA_LOCATION_CHANGE_CODE, changedFields: changed,
      message: `Changing ${changed.join(', ')} moves where files are stored; existing files are not moved. Resend with ${ACKNOWLEDGE}: true to confirm` });
    return from(this.acknowledge(request, changed, settings, next));
  }
  /** The acknowledgement is audited in the save's own transaction: no committed change without its audit row. */
  private acknowledge(request: LocationRequest, changed: string[], settings: ConnectionSettingsService, next: CallHandler): Promise<unknown> {
    return settings.withSaveAudit(async (tx, entry) => {
      if (entry.profileId !== PRIVATE_FILES_CONNECTION_PROFILE) return;
      await tx.model('operationLogs').create({ data: { module: 'files', action: 'acknowledge-data-location-change', status: 'SUCCESS',
        userId: request.user?.id ?? entry.actorId, targetId: PRIVATE_FILES_CONNECTION_PROFILE, targetType: 'connection-profile', method: 'PUT',
        path: `/management/connection-settings/${PRIVATE_FILES_CONNECTION_PROFILE}`,
        metadata: { revision: entry.revision, changedFields: changed, objectsMoved: false } } });
    }, () => lastValueFrom(next.handle()));
  }
}

/** Private files and public assets. `FILE_MANAGER` comes from `PrivateStorageModule` (composition root). */
@Module({
  imports: [AccountModule],
  controllers: [FilesController, FilesDownloadController, PublicAssetsController, PublicAssetsManagementController],
  providers: [
    { provide: FILES_OPTIONS, inject: [{ token: RUNTIME_ENVIRONMENT, optional: true }], useFactory: (env?: Readonly<NodeJS.ProcessEnv>) => filesOptionsFromEnvironment(env ?? process.env) },
    { provide: FILES_TRANSFER_OPTIONS, inject: [{ token: RUNTIME_ENVIRONMENT, optional: true }], useFactory: (env?: Readonly<NodeJS.ProcessEnv>) => filesTransferOptionsFromEnvironment(env ?? process.env) },
    // Allowlisted hosts are still resolved and pinned: every answer must be a public address (a DNS
    // record pointing an allowed name at 10/8, 127/8, link-local, ... is refused), https:443 only, no redirects.
    { provide: FILES_IMPORT_FETCH, useValue: createPublicFetch({ allowedProtocols: ['https:'], allowedPorts: [443] }) },
    { provide: PUBLIC_ASSETS_OPTIONS, inject: [{ token: RUNTIME_ENVIRONMENT, optional: true }], useFactory: (env?: Readonly<NodeJS.ProcessEnv>) => publicAssetsOptionsFromEnvironment(env ?? process.env) },
    FilesService, FilesDownloadService, FilesImportService, FileDownloadPrivacyGuard, PublicAssetsService,
    // Wake source `file-orphans` on the global Jobs host (absent in hosts without JobsModule).
    FileOrphanSweeper,
    // D14: guards storage location changes of the hot `private-files` profile.
    { provide: APP_INTERCEPTOR, useClass: StorageLocationGuard },
  ],
  exports: [FilesService, PublicAssetsService, FileOrphanSweeper],
})
export class FilesModule {}
