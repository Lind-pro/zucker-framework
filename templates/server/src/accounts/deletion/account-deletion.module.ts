import { Module, type DynamicModule, type InjectionToken, type ModuleMetadata, type Provider } from '@nestjs/common';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import type { ApplicationDatabase } from '../../database';
import { AccountModule } from '../account.module';
import { AccountDeletionController } from './account-deletion.controller';
import { AccountDeletionService } from './account-deletion.service';
import { ACCOUNT_DELETION_CONTRIBUTORS, orderContributors, type AccountDeletionContributor } from './account-deletion.types';
import { builtInDeletionContributors } from './contributors';

/** A contributor built by Nest (so it can use another feature's public service). */
export interface AccountDeletionContributorProvider {
  inject?: InjectionToken[];
  useFactory: (...dependencies: never[]) => AccountDeletionContributor | Promise<AccountDeletionContributor>;
}
export interface AccountDeletionModuleOptions {
  /** Modules exporting the services the extra contributors inject (e.g. AITasksModule, FilesModule). */
  imports?: ModuleMetadata['imports'];
  /** Extra contributors appended to the built-in erase list (feedback, inbox, referrals, AI cancellation, file cleanup…). */
  contributors?: readonly (AccountDeletionContributor | AccountDeletionContributorProvider)[];
}

/**
 * Account deletion (`/authorize/deletion*`, `account.delete` job, `account-deletions` wake source).
 * Kept out of `AccountModule` because it composes other features' data and services: the registry is
 * the built-in contributors plus `forRoot({ contributors })`, ordered and checked for duplicates at start-up.
 */
@Module({})
export class AccountDeletionModule {
  static forRoot(options: AccountDeletionModuleOptions = {}): DynamicModule {
    const extras = options.contributors ?? [];
    const providers: Provider[] = [];
    const tokens: symbol[] = [];
    extras.forEach((entry, index) => {
      const token = Symbol(`ACCOUNT_DELETION_CONTRIBUTOR_${index}`);
      tokens.push(token);
      providers.push('useFactory' in entry
        ? { provide: token, inject: entry.inject ?? [], useFactory: entry.useFactory as (...args: unknown[]) => unknown }
        : { provide: token, useValue: entry });
    });
    providers.push({
      provide: ACCOUNT_DELETION_CONTRIBUTORS,
      inject: [DATABASE_ADAPTER, ...tokens],
      useFactory: (database: ApplicationDatabase, ...registered: AccountDeletionContributor[]) =>
        orderContributors([...builtInDeletionContributors(database), ...registered]),
    });
    return {
      module: AccountDeletionModule,
      imports: [AccountModule, ...(options.imports ?? [])],
      controllers: [AccountDeletionController],
      providers: [...providers, AccountDeletionService],
      exports: [AccountDeletionService, ACCOUNT_DELETION_CONTRIBUTORS],
    };
  }
}
