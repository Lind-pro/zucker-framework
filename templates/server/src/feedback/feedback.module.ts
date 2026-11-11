import { Module, type DynamicModule, type FactoryProvider, type ModuleMetadata } from '@nestjs/common';
import { FeedbackController, FeedbackManagementController } from './feedback.controller';
import { FeedbackService } from './feedback.service';
import { FEEDBACK_NOTIFIER, type FeedbackNotifier } from './feedback.tokens';

export interface FeedbackModuleOptions {
  /** Modules the notifier factory needs (for example the inbox module). */
  imports?: ModuleMetadata['imports'];
  /** Binds the optional `FEEDBACK_NOTIFIER` port. */
  notifier?: Omit<FactoryProvider<FeedbackNotifier>, 'provide'>;
}

/**
 * `/feedback` (owner) and `/management/feedback` (back office). Needs the global `PolicyModule` with
 * `FEEDBACK_POLICIES`, the CRUD database adapter and the `FEEDBACK_RATE_LIMITERS` budgets. Import the
 * class as is, or `FeedbackModule.forRoot({ notifier })` to notify owners of replies.
 */
@Module({
  controllers: [FeedbackController, FeedbackManagementController],
  providers: [FeedbackService],
  exports: [FeedbackService],
})
export class FeedbackModule {
  static forRoot(options: FeedbackModuleOptions = {}): DynamicModule {
    return {
      module: FeedbackModule,
      imports: options.imports ?? [],
      providers: options.notifier ? [{ provide: FEEDBACK_NOTIFIER, ...options.notifier }] : [],
    };
  }
}
