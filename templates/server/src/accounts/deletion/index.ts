import type { AccountDeletionContributor as HostContributor } from '@zucker-framework/back-office/accounts';
import type { ApplicationTransaction } from '../../database';

/** Contributors of this template receive the application transaction (typed models + fixed SQL). */
export type AccountDeletionContributor = HostContributor<ApplicationTransaction>;
export { AccountDeletionPostponedError, orderContributors, type AccountDeletionContributorProvider } from '@zucker-framework/back-office/accounts';
export { AccountDeletionModule, type AccountDeletionModuleOptions } from './account-deletion.module';
export { AccountDeletionService, ACCOUNT_DELETION_JOB, ACCOUNT_DELETION_WAKE_SOURCE, FAILED_DELETION_RETRY_MS } from './account-deletion.service';
export { aiTaskCancellationContributor, privateFileCleanupContributor, builtInDeletionContributors, type AITaskCanceller, type PrivateFileRecovery } from './contributors';
