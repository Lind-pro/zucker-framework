export type {
  FileManager,
  UploadOptions,
  UploadResult,
  FileInfo,
  StorageProviderType,
  FileUploadValidation,
  ChunkUploadState,
  PosixFilePermissions,
} from './storage.interface';
export { isFileDenied, generateDateBasedKey, DANGEROUS_EXTENSIONS, sanitizeFileName, isSafeOriginalFileName } from './storage.interface';

export enum StorageProvider {
  LOCAL = 'LOCAL',
  S3 = 'S3',
  WEBDAV = 'WEBDAV',
}

export { LocalFileStorage } from './local-storage';
export { S3Storage } from './s3-storage';
export type { S3StorageOptions } from './s3-storage';
export { WebDavStorage } from './webdav-storage';
export type { WebDavStorageOptions } from './webdav-storage';
export {
  FileLifecycleManager,
  type FileLifecyclePolicy,
  type FileMetadata,
  type LifecycleResult,
} from './file-lifecycle';
export { ZuckerStorageModule, FILE_MANAGER } from './storage.module';
export type { StorageModuleOptions, StorageModuleAsyncOptions, StorageModuleOptionsFactory } from './storage.module';
