import { Module, type DynamicModule, type Type } from '@nestjs/common';
import { I18nManagementController } from './i18n.controller';
import { I18N_STORE, InMemoryI18nStore, type I18nStoreInterface } from './i18n.store';

export interface I18nAdminModuleOptions {
  /**
   * Custom i18n store implementation.
   * Defaults to InMemoryI18nStore.
   * Implement I18nStoreInterface and provide your class here to persist entries.
   */
  store?: Type<I18nStoreInterface>;
}

/**
 * ZuckerI18nAdminModule — pluggable i18n CRUD admin module.
 *
 * Usage (default in-memory store):
 * ```typescript
 * ZuckerI18nAdminModule.forRoot()
 * ```
 *
 * Usage (custom persistent store):
 * ```typescript
 * ZuckerI18nAdminModule.forRoot({ store: MyDatabaseI18nStore })
 * ```
 */
@Module({})
export class ZuckerI18nAdminModule {
  static forRoot(options: I18nAdminModuleOptions = {}): DynamicModule {
    const StoreClass = options.store ?? InMemoryI18nStore;
    return {
      module: ZuckerI18nAdminModule,
      controllers: [I18nManagementController],
      providers: [
        StoreClass,
        { provide: I18N_STORE, useExisting: StoreClass },
      ],
    };
  }
}
