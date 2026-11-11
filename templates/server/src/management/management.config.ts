import { Inject, Injectable } from '@nestjs/common';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import {
  resolveManagementOptions,
  type ManagementCreditGrant,
  type ManagementCreditLedgerPort,
  type ManagementCreditsPort,
  type ManagementRefundOrder,
  type ManagementRefundSummaryPort,
  type ManagementSqlTransaction,
} from '@zucker-framework/back-office/management';
import { ApplicationDatabase, type ApplicationTransaction } from '../database';
import { createCreditLedger } from '../billing/ledger';
import { readOrderRefundSummary } from '@zucker-framework/back-office/billing';
import { CreditsService, creditPageOptions } from '../credits/credits.service';
import { ConnectionsService } from './connections.service';

/** Order refund column from the billing refund projection. */
@Injectable()
export class TemplateRefundSummary implements ManagementRefundSummaryPort {
  constructor(@Inject(DATABASE_ADAPTER) private readonly database: ApplicationDatabase) {}
  summarize(order: ManagementRefundOrder) { return readOrderRefundSummary(this.database, order); }
}

/** Credit balance and lots through the template credits service. */
@Injectable()
export class TemplateCreditsPort implements ManagementCreditsPort {
  constructor(private readonly credits: CreditsService) {}
  balance(ownerId: string) { return this.credits.balance(ownerId); }
  lots(ownerId: string, query: Record<string, unknown>) { return this.credits.lots(ownerId, creditPageOptions(query, false)); }
}
/** Administrator grants go through the template's batch credit ledger. */
@Injectable()
export class TemplateCreditLedger implements ManagementCreditLedgerPort {
  private readonly ledger;
  constructor(@Inject(DATABASE_ADAPTER) database: ApplicationDatabase) { this.ledger = createCreditLedger(database); }
  grant(tx: ManagementSqlTransaction, grant: ManagementCreditGrant) { return this.ledger.grant(tx as unknown as ApplicationTransaction, grant); }
}

/**
 * The template's `/management/*` composition: every record list, credit accounts, the connection
 * inventory; Origin allow-list from `ACCOUNT_ORIGINS`; global AccountGuard/PermissionsGuard (so no
 * controller guards) plus the `api-default` user-keyed limiter.
 */
export const MANAGEMENT_OPTIONS = resolveManagementOptions({
  features: { credits: true },
  guards: [],
  trustedOrigins: () => (process.env.ACCOUNT_ORIGINS ?? 'http://localhost:4201,http://localhost:4202').split(','),
  ports: { refunds: TemplateRefundSummary, credits: TemplateCreditsPort, creditLedger: TemplateCreditLedger, connections: ConnectionsService },
});
