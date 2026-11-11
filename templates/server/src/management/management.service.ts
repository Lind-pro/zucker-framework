import { Inject, Injectable, Optional } from '@nestjs/common';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { AccessLogService, OperationLogService } from '@zucker-framework/logging';
import { BackOfficeManagementService, type ManagementResource } from '@zucker-framework/back-office/management';
import { ApplicationDatabase } from '../database';
import { CreditsService } from '../credits/credits.service';
import { MANAGEMENT_OPTIONS, TemplateCreditLedger, TemplateCreditsPort, TemplateRefundSummary } from './management.config';

export type { ManagementResource } from '@zucker-framework/back-office/management';

/** The back-office projection service bound to the template's database, credits and refund projection. */
@Injectable()
export class ManagementService {
  private readonly host: BackOfficeManagementService;
  constructor(@Inject(DATABASE_ADAPTER) database: ApplicationDatabase, @Inject(CreditsService) credits: CreditsService,
    @Optional() @Inject(AccessLogService) accessLogs?: AccessLogService, @Optional() @Inject(OperationLogService) operationLogs?: OperationLogService) {
    this.host = new BackOfficeManagementService(database, MANAGEMENT_OPTIONS, new TemplateRefundSummary(database), new TemplateCreditsPort(credits),
      new TemplateCreditLedger(database), accessLogs, operationLogs);
  }
  list(resource: ManagementResource, query: Record<string, unknown>) { return this.host.list(resource, query); }
  creditBalance(ownerId: string) { return this.host.creditBalance(ownerId); }
  creditLots(ownerId: string, query: Record<string, unknown>) { return this.host.creditLots(ownerId, query); }
  grant(actorId: string, ownerId: string, key: unknown, body: unknown) { return this.host.grant(actorId, ownerId, key, body); }
}
