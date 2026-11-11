import { Module } from '@nestjs/common';
import { InboxController } from './inbox.controller';
import { INBOX_OPTIONS, InboxEventScanner, inboxOptionsFromEnvironment } from './inbox.runtime';
import { INBOX_EMITTER, InboxService } from './inbox.service';

/**
 * In-app notifications: `/inbox*` for the signed-in user, the `inbox-events` wake source (committed
 * billing/AI rows → notifications, plus retention) on the global JobsModule, and `INBOX_EMITTER`
 * for features that post notifications themselves.
 */
@Module({
  controllers: [InboxController],
  providers: [InboxService, InboxEventScanner,
    { provide: INBOX_EMITTER, useExisting: InboxService },
    { provide: INBOX_OPTIONS, useFactory: () => inboxOptionsFromEnvironment(process.env) }],
  exports: [InboxService, INBOX_EMITTER],
})
export class InboxModule {}
