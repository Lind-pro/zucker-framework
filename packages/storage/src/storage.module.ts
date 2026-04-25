import {
  Module,
  DynamicModule,
  Global,
  type Provider,
  type Type,
  type InjectionToken,
  type OptionalFactoryDependency,
} from '@nestjs/common';
import { LocalFileStorage } from './local-storage';
import { S3Storage, S3StorageOptions } from './s3-storage';
import { WebDavStorage, WebDavStorageOptions } from './webdav-storage';
import type { FileManager } from './storage.interface';

export const FILE_MANAGER = 'FILE_MANAGER';

export type StorageModuleOptions =
  | { provider: 'local'; basePath: string; baseUrl?: string }
  | ({ provider: 's3' } & S3StorageOptions)
  | ({ provider: 'webdav' } & WebDavStorageOptions);

export interface StorageModuleAsyncOptions {
  imports?: Array<Type | DynamicModule>;
  useFactory?: (...args: unknown[]) => StorageModuleOptions | Promise<StorageModuleOptions>;
  useClass?: Type<StorageModuleOptionsFactory>;
  useExisting?: Type<StorageModuleOptionsFactory>;
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
}

export interface StorageModuleOptionsFactory {
  createStorageOptions(): StorageModuleOptions | Promise<StorageModuleOptions>;
}

const STORAGE_MODULE_OPTIONS = Symbol('STORAGE_MODULE_OPTIONS');

@Global()
@Module({})
export class ZuckerStorageModule {
  static forRoot(options: StorageModuleOptions): DynamicModule {
    return {
      module: ZuckerStorageModule,
      providers: [
        {
          provide: FILE_MANAGER,
          useFactory: (): FileManager => ZuckerStorageModule.createFileManager(options),
        },
      ],
      exports: [FILE_MANAGER],
    };
  }

  static forRootAsync(options: StorageModuleAsyncOptions): DynamicModule {
    const asyncProviders = this.createAsyncProviders(options);
    return {
      module: ZuckerStorageModule,
      imports: options.imports ?? [],
      providers: [
        ...asyncProviders,
        {
          provide: FILE_MANAGER,
          useFactory: (opts: StorageModuleOptions): FileManager =>
            ZuckerStorageModule.createFileManager(opts),
          inject: [STORAGE_MODULE_OPTIONS],
        },
      ],
      exports: [FILE_MANAGER],
    };
  }

  private static createFileManager(options: StorageModuleOptions): FileManager {
    if (options.provider === 'local') {
      return new LocalFileStorage({
        basePath: options.basePath,
        baseUrl: options.baseUrl,
      });
    }
    if (options.provider === 'webdav') {
      const { provider: _, ...webdavOpts } = options;
      return new WebDavStorage(webdavOpts);
    }
    const { provider: _, ...s3Opts } = options;
    return new S3Storage(s3Opts);
  }

  private static createAsyncProviders(options: StorageModuleAsyncOptions): Provider[] {
    if (options.useFactory) {
      return [
        {
          provide: STORAGE_MODULE_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
      ];
    }
    const optionsProvider: Provider = {
      provide: STORAGE_MODULE_OPTIONS,
      useFactory: async (factory: StorageModuleOptionsFactory) => factory.createStorageOptions(),
      inject: [options.useClass ?? options.useExisting!],
    };
    if (options.useClass) {
      return [{ provide: options.useClass, useClass: options.useClass }, optionsProvider];
    }
    return [optionsProvider];
  }
}
