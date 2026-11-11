import { Inject, Injectable, Optional } from '@nestjs/common';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import {
  PaymentCredentialRetention as HostPaymentCredentialRetention, paymentRevisionRetentionDays as hostRetentionDays,
} from '@zucker-framework/back-office/billing';
import { ApplicationDatabase } from '../database';
import { ConnectionSettingsService } from '../runtime-settings/connection-settings.service';
import { BillingService } from './billing.service';
import { PAYMENT_PROFILE_PROVIDERS } from './providers';

export {
  PAYMENT_REVISION_RETENTION_MIN_DAYS, type PaymentRevisionHold, type PaymentRevisionStatus, type PaymentPurgeRequest, type PaymentPurgeContext,
} from '@zucker-framework/back-office/billing';

/** `CONNECTION_REVISION_RETENTION_DAYS` (default and minimum 400). */
export function paymentRevisionRetentionDays(env: Readonly<NodeJS.ProcessEnv>): number {
  try { return hostRetentionDays(env.CONNECTION_REVISION_RETENTION_DAYS); }
  catch { throw new Error('CONNECTION_REVISION_RETENTION_DAYS must be an integer from 400 to 36500'); }
}

/** Operator purge of superseded payment credentials (D13) over the template's connection profile archive. */
@Injectable()
export class PaymentCredentialRetention extends HostPaymentCredentialRetention {
  constructor(@Inject(DATABASE_ADAPTER) database: ApplicationDatabase, billing: BillingService,
    @Optional() connections?: ConnectionSettingsService) {
    // Validated at start-up: a retention below the 400-day floor is a configuration error.
    super(database, billing, connections?.runtime.store, { retentionDays: paymentRevisionRetentionDays(connections?.runtime.base ?? process.env),
      profiles: PAYMENT_PROFILE_PROVIDERS, storage: billing.persistence.storage });
  }
}
