import { DATABASE_ADAPTER } from '@zucker-framework/core';
import type { ApplicationDatabase } from '../../database';
import { AITasksService } from '../../ai-tasks/ai-tasks.service';
import { FilesService } from '../../files/files.service';
import { feedbackDeletionContributor } from '../../feedback/feedback.deletion';
import { inboxDeletionContributor } from '../../inbox/inbox-deletion';
import { referralDeletionContributor } from '../../referrals/referral-deletion';
import type { AccountDeletionContributorProvider } from './account-deletion.module';
import type { AccountDeletionContributor } from './account-deletion.types';
import { aiTaskCancellationContributor, privateFileCleanupContributor } from './contributors';

/**
 * Application composition of the account-deletion registry: the feature contributors that live
 * outside `accounts/` (registered with `AccountDeletionModule.forRoot({ imports: [AITasksModule,
 * FilesModule], contributors: APP_DELETION_CONTRIBUTORS })`). Every feature that stores personal data
 * of a user belongs here. Resulting order (asserted by test/account-deletion-registry.unit.e2e-spec.ts):
 *
 *   referrals 10 → feedback 50 → inbox 60 → ai-task-cancellation 90 → ai-tasks 100 → chats 110 →
 *   record-jobs 120 → files 200 → private-file-cleanup 210 → credits 300 → api-keys 400 →
 *   sessions 500 → authorization 600 → sign-in-history 700 → two-factor 800 → logs 900
 *
 * Invariants: referrals run before contributors that take credit-account locks (credits 300);
 * AI cancellation runs before the AI-task erase (which postpones while a task is still running);
 * private-file cleanup runs after the built-in `files` tombstones.
 */
export const APP_DELETION_CONTRIBUTORS: readonly (AccountDeletionContributor | AccountDeletionContributorProvider)[] = [
  referralDeletionContributor,
  feedbackDeletionContributor,
  inboxDeletionContributor,
  { inject: [AITasksService], useFactory: ((service: AITasksService) => aiTaskCancellationContributor(service.tasks)) as AccountDeletionContributorProvider['useFactory'] },
  { inject: [DATABASE_ADAPTER, FilesService],
    useFactory: ((database: ApplicationDatabase, files: FilesService) => privateFileCleanupContributor(database, files)) as AccountDeletionContributorProvider['useFactory'] },
];
