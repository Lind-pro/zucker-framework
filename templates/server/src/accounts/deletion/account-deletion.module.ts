import { Module, type DynamicModule, type ModuleMetadata, type Provider } from '@nestjs/common';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import {
  ACCOUNTS_DELETION_CONTRIBUTORS, ACCOUNTS_DELETION_SCHEDULER, AccountDeletionController, AccountDeletionService as HostDeletionService, orderContributors,
  type AccountDeletionContributorProvider,
} from '@zucker-framework/back-office/accounts';
import type { ApplicationDatabase } from '../../database';
import { AccountModule } from '../account.module';
import { AccountDeletionService } from './account-deletion.service';
import { builtInDeletionContributors } from './contributors';
import type { AccountDeletionContributor } from './index';

export interface AccountDeletionModuleOptions {
  /** Modules exporting the services the extra contributors inject (e.g. AITasksModule, FilesModule). */
  imports?: ModuleMetadata['imports'];
  /** Extra contributors appended to the built-in erase list (feedback, inbox, referrals, AI cancellation, file cleanup…). */
  contributors?: readonly (AccountDeletionContributor | AccountDeletionContributorProvider)[];
}

/**
 * Account deletion (`/authorize/deletion*`, `account.delete` job, `account-deletions` wake source) over the
 * account host. The registry is the built-in contributors plus `forRoot({ contributors })`, ordered and
 * checked for duplicates at start-up.
 */
@Module({})
export class AccountDeletionModule {
  static forRoot(options: AccountDeletionModuleOptions = {}): DynamicModule {
    const providers: Provider[] = [], tokens: symbol[] = [];
    (options.contributors ?? []).forEach((entry, index) => {
      const token = Symbol(`ACCOUNT_DELETION_CONTRIBUTOR_${index}`);
      tokens.push(token);
      providers.push('useFactory' in entry
        ? { provide: token, inject: entry.inject ?? [], useFactory: entry.useFactory as (...args: unknown[]) => unknown }
        : { provide: token, useValue: entry });
    });
    providers.push({ provide: ACCOUNTS_DELETION_CONTRIBUTORS, inject: [DATABASE_ADAPTER, ...tokens],
      useFactory: (database: ApplicationDatabase, ...registered: AccountDeletionContributor[]) =>
        orderContributors([...builtInDeletionContributors(database), ...registered]) });
    return {
      module: AccountDeletionModule,
      imports: [AccountModule, ...(options.imports ?? [])],
      controllers: [AccountDeletionController],
      // Durable execution is the subclass's Jobs binding; Nest does not inherit @Optional, so the port is stated explicitly.
      providers: [...providers, { provide: ACCOUNTS_DELETION_SCHEDULER, useValue: null }, AccountDeletionService, { provide: HostDeletionService, useExisting: AccountDeletionService }],
      exports: [AccountDeletionService, HostDeletionService, ACCOUNTS_DELETION_CONTRIBUTORS],
    };
  }
}
