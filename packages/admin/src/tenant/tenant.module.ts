import { Module, type DynamicModule, type Type } from '@nestjs/common';
import { TenantManagementController } from './tenant.controller';
import { TENANT_STORE, InMemoryTenantStore, type TenantStoreInterface } from './tenant.store';

export interface TenantAdminModuleOptions {
  /**
   * Custom tenant store implementation.
   * Defaults to InMemoryTenantStore.
   * Implement TenantStoreInterface and provide your class here to persist records.
   */
  store?: Type<TenantStoreInterface>;
}

/**
 * ZuckerTenantAdminModule — pluggable tenant CRUD admin module.
 *
 * Usage (default in-memory store):
 * ```typescript
 * ZuckerTenantAdminModule.forRoot()
 * ```
 *
 * Usage (custom persistent store):
 * ```typescript
 * ZuckerTenantAdminModule.forRoot({ store: MyDatabaseTenantStore })
 * ```
 */
@Module({})
export class ZuckerTenantAdminModule {
  static forRoot(options: TenantAdminModuleOptions = {}): DynamicModule {
    const StoreClass = options.store ?? InMemoryTenantStore;
    return {
      module: ZuckerTenantAdminModule,
      controllers: [TenantManagementController],
      providers: [
        StoreClass,
        { provide: TENANT_STORE, useExisting: StoreClass },
      ],
    };
  }
}
