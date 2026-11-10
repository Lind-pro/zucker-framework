export type {
  FileManager,
  UploadOptions,
  UploadResult,
  FileInfo,
  StorageProviderType,
  FileUploadValidation,
  FileDenyCheckOptions,
  ChunkUploadState,
  PosixFilePermissions,
} from './storage.interface';
export {
  isFileDenied,
  generateDateBasedKey,
  DANGEROUS_EXTENSIONS,
  sanitizeFileName,
  isSafeOriginalFileName,
} from './storage.interface';

export enum StorageProvider {
  LOCAL = 'LOCAL',
  S3 = 'S3',
  WEBDAV = 'WEBDAV',
}

export { LocalFileStorage } from './local-storage';
export { S3Storage } from './s3-storage';
export type { S3StorageOptions, S3ObjectAclMode, S3UploadUrlMode } from './s3-storage';
export { WebDavStorage } from './webdav-storage';
export type { WebDavStorageOptions, WebDavEntry } from './webdav-storage';
export {
  FileLifecycleManager,
  type FileLifecyclePolicy,
  type FileMetadata,
  type LifecycleResult,
} from './file-lifecycle';
export { ZuckerStorageModule, FILE_MANAGER } from './storage.module';
export type {
  StorageModuleOptions,
  StorageModuleAsyncOptions,
  StorageModuleOptionsFactory,
} from './storage.module';

export { hydrateStorageUrls, type StorageUrlHydrationOptions } from './storage-url-hydrator';

export { UnavailableFileManager } from './unavailable-file-manager';

export {
  transferVerifiedObject,
  verifyStoredObject,
  StorageTransferError,
} from './verified-object-transfer';
export type {
  BufferedObjectStore,
  DownloadedStorageObject,
  VerifiedStorageMetadata,
  VerifiedObjectTransferOptions,
  StorageTransferErrorCode,
  StorageTransferErrorFactory,
} from './verified-object-transfer';
export { BufferedFileManagerStore } from './buffered-file-manager-store';
export { PrivateFileAssetService } from './private-file-asset.service';
export { FileAssetError } from './file-asset';
export type {
  FileAsset, FileAssetState, FileAssetAction, FileAssetReservation, FileAssetMutation,
  FileAssetRepository, PrivateFileObjectStore, FileAssetAccessRequest,
  PrivateFileAssetOptions, FileAssetErrorCode,
} from './file-asset';
