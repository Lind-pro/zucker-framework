import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Put,
  Query,
  Req,
  UseGuards,
  type CanActivate,
  type InjectionToken,
  type Type,
} from '@nestjs/common';
import { JwtAuthGuard, Permissions, PermissionsGuard } from '@zucker-framework/auth';
import { AccessLogger } from '@zucker-framework/logging';
import {
  USER_SUBSCRIPTION_ACTIVITY,
  USER_SUBSCRIPTION_CYCLES,
  USER_SUBSCRIPTION_STATUSES,
  type BackOfficePage,
  type UserSubscriptionActivity,
  type UserSubscriptionCycle,
  type UserSubscriptionDetail,
  type UserSubscriptionRow,
  type UserSubscriptionStatus,
} from '@zucker-framework/fe-types/back-office';
import { viaPort } from '../port-errors';

export { USER_SUBSCRIPTION_STATUSES, USER_SUBSCRIPTION_CYCLES };

export interface UserSubscriptionListQuery {
  page: number;
  pageSize: number;
  userId?: string;
  /** Stored status. Expiry is not swept, so use `activity` for "currently valid". */
  status?: UserSubscriptionStatus;
  /** Derived validity at request time (`active` = the term grants entitlements now). */
  activity?: UserSubscriptionActivity;
  planSlug?: string;
}
export interface UserSubscriptionAssignment {
  planSlug: string;
  billingCycle: UserSubscriptionCycle;
  status: UserSubscriptionStatus;
  startDate?: Date;
  /** null is accepted only to state "no end" explicitly (lifetime). */
  endDate?: Date | null;
}
/**
 * Host port composing the user directory, plan catalog, `SubscriptionAssignmentService`
 * (`@zucker-framework/payment`) and quota snapshots. Rejections are branded port errors
 * (invalid / not_found / pending_payment with `details.blocking` / conflict).
 */
export interface UserSubscriptionAdminPort {
  /** Rows include a user summary (id, username, email) and a plan summary. */
  list(query: UserSubscriptionListQuery): Promise<BackOfficePage<UserSubscriptionRow<Date | string>>>;
  /** The flat subscription row plus effective features and counter snapshots; null when none. */
  detail(userId: string): Promise<UserSubscriptionDetail<Date | string> | null>;
  assign(userId: string, input: UserSubscriptionAssignment, actorId: string | undefined): Promise<UserSubscriptionDetail<Date | string> | null>;
  cancel(userId: string, actorId: string | undefined): Promise<UserSubscriptionDetail<Date | string> | null>;
}
export interface UserSubscriptionAdminOptions {
  /** Default `management/subscriptions`. */
  path?: string;
  service: InjectionToken;
  /** Defaults: subscriptions:query / subscriptions:update. */
  permissions?: Partial<{ query: string; update: string }>;
  auditModule?: string;
  guards?: Type<CanActivate>[];
  maxPageSize?: number;
}
export interface UserSubscriptionAdminController {
  list(query: Record<string, unknown>): Promise<BackOfficePage<UserSubscriptionRow<Date | string>>>;
  detail(userId: string): Promise<UserSubscriptionDetail<Date | string>>;
  assign(request: { user?: { id?: string } }, userId: string, body: unknown): Promise<UserSubscriptionDetail<Date | string> | null>;
  cancel(request: { user?: { id?: string } }, userId: string): Promise<UserSubscriptionDetail<Date | string> | null>;
}

const IDENTIFIER = /^[A-Za-z0-9_.:@-]{1,128}$/;
function text(value: unknown, field: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new BadRequestException(`Invalid ${field}`);
  return value;
}
function positive(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if ((typeof value !== 'string' && typeof value !== 'number') || !Number.isSafeInteger(number) || number < 1)
    throw new BadRequestException('Invalid page');
  return number;
}
function isoDate(value: unknown, field: string): Date | undefined | null {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const parsed = typeof value === 'string' && value.length <= 40 ? new Date(value) : new Date(Number.NaN);
  if (!Number.isFinite(parsed.getTime())) throw new BadRequestException(`Invalid ${field}`);
  return parsed;
}

/** RFC 8.3 user subscription administration with a pending-payment guard enforced by the port. */
export function createUserSubscriptionAdminController(
  options: UserSubscriptionAdminOptions,
): Type<UserSubscriptionAdminController> {
  const permissions = { query: 'subscriptions:query', update: 'subscriptions:update', ...options.permissions };
  const module = options.auditModule ?? 'subscriptions';

  @Controller(options.path ?? 'management/subscriptions')
  @UseGuards(...(options.guards ?? [JwtAuthGuard, PermissionsGuard]))
  class UserSubscriptionController implements UserSubscriptionAdminController {
    constructor(@Inject(options.service) readonly subscriptions: UserSubscriptionAdminPort) {}

    @Get()
    @Permissions(permissions.query)
    list(@Query() query: Record<string, unknown>) {
      const status = query.status;
      if (status !== undefined && status !== '' && !USER_SUBSCRIPTION_STATUSES.includes(status as 'ACTIVE'))
        throw new BadRequestException('Invalid status');
      const activity = query.active;
      if (activity !== undefined && activity !== '' && !USER_SUBSCRIPTION_ACTIVITY.includes(activity as 'active'))
        throw new BadRequestException('Invalid active filter');
      const filters: UserSubscriptionListQuery = {
        page: positive(query.page, 1),
        pageSize: Math.min(positive(query.pageSize, 20), options.maxPageSize ?? 100),
        userId: text(query.userId, 'userId'),
        status: status ? (status as UserSubscriptionListQuery['status']) : undefined,
        activity: activity ? (activity as UserSubscriptionActivity) : undefined,
        planSlug: text(query.planSlug, 'planSlug'),
      };
      return viaPort(() => this.subscriptions.list(filters));
    }

    @Get(':userId')
    @Permissions(permissions.query)
    async detail(@Param('userId') userId: string) {
      const id = text(userId, 'userId');
      const result = await viaPort(() => this.subscriptions.detail(id as string));
      if (result === null) throw new NotFoundException('Subscription not found');
      return result;
    }

    @Put(':userId')
    @Permissions(permissions.update)
    @AccessLogger({ module, action: 'assign', describe: '指派或修改用户订阅', logParameters: true })
    assign(@Req() request: { user?: { id?: string } }, @Param('userId') userId: string, @Body() body: unknown) {
      const id = text(userId, 'userId') as string;
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Invalid subscription');
      const input = body as Record<string, unknown>;
      const allowed = ['planSlug', 'billingCycle', 'status', 'startDate', 'endDate'];
      const unknown = Object.keys(input).find((key) => !allowed.includes(key));
      if (unknown) throw new BadRequestException(`Unsupported field: ${unknown}`);
      const planSlug = text(input.planSlug, 'planSlug');
      if (!planSlug) throw new BadRequestException('planSlug is required');
      if (!USER_SUBSCRIPTION_CYCLES.includes(input.billingCycle as 'MONTHLY')) throw new BadRequestException('Invalid billingCycle');
      const status = input.status ?? 'ACTIVE';
      if (!USER_SUBSCRIPTION_STATUSES.includes(status as 'ACTIVE')) throw new BadRequestException('Invalid status');
      const startDate = isoDate(input.startDate, 'startDate');
      if (startDate === null) throw new BadRequestException('Invalid startDate');
      const endDate = isoDate(input.endDate, 'endDate');
      return viaPort(() =>
        this.subscriptions.assign(
          id,
          {
            planSlug,
            billingCycle: input.billingCycle as UserSubscriptionAssignment['billingCycle'],
            status: status as UserSubscriptionAssignment['status'],
            ...(startDate ? { startDate } : {}),
            ...(endDate !== undefined ? { endDate } : {}),
          },
          request.user?.id,
        ),
      );
    }

    @Delete(':userId')
    @HttpCode(200)
    @Permissions(permissions.update)
    @AccessLogger({ module, action: 'cancel', describe: '取消用户订阅（保留到期日；终身订阅请以 EXPIRED 撤销）' })
    cancel(@Req() request: { user?: { id?: string } }, @Param('userId') userId: string) {
      const id = text(userId, 'userId') as string;
      return viaPort(() => this.subscriptions.cancel(id, request.user?.id));
    }
  }
  return UserSubscriptionController;
}
