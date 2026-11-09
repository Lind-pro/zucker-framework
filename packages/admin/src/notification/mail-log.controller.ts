import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Query,
  UseGuards,
  type CanActivate,
  type Type,
} from '@nestjs/common';
import { JwtAuthGuard, Permissions, PermissionsGuard } from '@zucker-framework/auth';
import { MailHistoryService } from '@zucker-framework/notification';

export interface MailLogAdminOptions {
  /** Default `management/email-logs`. */
  path?: string;
  /** Default mail:query. */
  permission?: string;
  guards?: Type<CanActivate>[];
}
export interface MailLogAdminController {
  list(query: Record<string, unknown>): Promise<unknown>;
}

/** Returned fields; provider metadata (reply-to, idempotency keys, campaign data) is not exposed. */
export const MAIL_LOG_FIELDS = [
  'id', 'userId', 'recipient', 'subject', 'template', 'provider', 'messageId', 'status', 'errorMessage', 'createdAt',
] as const;
const STATUSES = ['success', 'failed'];

function positive(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if ((typeof value !== 'string' && typeof value !== 'number') || !Number.isSafeInteger(number) || number < 1)
    throw new BadRequestException('Invalid page');
  return number;
}
function filter(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max) throw new BadRequestException(`Invalid ${field}`);
  return value;
}

/** RFC 8.5 delivery log over the configured MailService history (`to,status,template` filters). */
export function createMailLogAdminController(options: MailLogAdminOptions = {}): Type<MailLogAdminController> {
  @Controller(options.path ?? 'management/email-logs')
  @UseGuards(...(options.guards ?? [JwtAuthGuard, PermissionsGuard]))
  class MailLogController implements MailLogAdminController {
    constructor(@Inject(MailHistoryService) readonly history: MailHistoryService) {}
    @Get()
    @Permissions(options.permission ?? 'mail:query')
    async list(@Query() query: Record<string, unknown>) {
      const status = filter(query.status, 'status', 20);
      if (status && !STATUSES.includes(status)) throw new BadRequestException('Invalid status');
      const result = await this.history.list({
        recipient: filter(query.to, 'to', 254),
        status,
        template: filter(query.template, 'template', 64),
        userId: filter(query.userId, 'userId', 128),
        page: positive(query.page, 1),
        pageSize: Math.min(positive(query.pageSize, 20), 100),
      });
      return {
        ...result,
        data: result.data.map((row) =>
          Object.fromEntries(MAIL_LOG_FIELDS.map((field) => [field, row[field] ?? null])),
        ),
      };
    }
  }
  return MailLogController;
}
