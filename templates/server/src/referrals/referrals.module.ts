import { Module, type DynamicModule, type FactoryProvider, type ModuleMetadata } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { ReferralRewards } from './referral-rewards';
import { REFERRAL_NOTIFIER, REFERRAL_OPTIONS, referralOptionsFromEnvironment, type ReferralNotifier } from './referral.tokens';
import { ReferralsController, ReferralsManagementController } from './referrals.controller';
import { ReferralsService } from './referrals.service';

/**
 * Referral programme: `/referrals/me`, `/referrals/claim`, `/management/referrals*` and the
 * `referral-rewards` wake source. Needs `PolicyModule` with `REFERRAL_POLICIES` (otherwise the
 * programme stays off), the global runtime settings (external-affiliate exclusion) and the Jobs host.
 * `REFERRAL_NOTIFIER` is optional; bind it in the application module to notify rewarded users.
 */
@Module({
  imports: [JobsModule],
  controllers: [ReferralsController, ReferralsManagementController],
  providers: [ReferralsService, ReferralRewards,
    { provide: REFERRAL_OPTIONS, useFactory: () => referralOptionsFromEnvironment(process.env) }],
  exports: [ReferralsService, ReferralRewards],
})
export class ReferralsModule {
  /** Binds the optional `REFERRAL_NOTIFIER` port (e.g. to the inbox) inside this module's scope. */
  static forRoot(options: { imports?: ModuleMetadata['imports']; notifier?: Omit<FactoryProvider<ReferralNotifier>, 'provide'> } = {}): DynamicModule {
    return {
      module: ReferralsModule,
      imports: options.imports ?? [],
      providers: options.notifier ? [{ provide: REFERRAL_NOTIFIER, ...options.notifier }] : [],
    };
  }
}
