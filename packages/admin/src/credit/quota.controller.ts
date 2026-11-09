import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
  type CanActivate,
  type InjectionToken,
  type Type,
} from '@nestjs/common';
import { DATABASE_ADAPTER, type DatabaseAdapter } from '@zucker-framework/core';
import { JwtAuthGuard, Permissions, PermissionsGuard } from '@zucker-framework/auth';
import { AccessLogger } from '@zucker-framework/logging';
import { createReadOnlyRecordReader, type ReadOnlyProjection } from '../read-only.controller';
import { viaPort } from '../port-errors';

/** `QuotaReservationService` from `@zucker-framework/credit` satisfies this port. */
export interface QuotaReservationAdminPort {
  confirm(id: string): Promise<boolean>;
  release(id: string, reason?: string): Promise<boolean>;
}

export interface QuotaAdminOptions {
  /** Defaults `management/quota-usage` and `management/quota-reservations`. */
  usagePath?: string;
  reservationsPath?: string;
  /** Host model names; defaults `quotaUsage` and `quotaReservation`. */
  usageModel?: string;
  reservationModel?: string;
  /**
   * Response key → model field. Defaults match the Framework server template
   * (`userId` ← `subjectId`) and omit internal metadata such as the policy version.
   * Filters `userId,counter,period` (usage) and `userId,counter,status,resourceType`
   * (reservations) must be projected.
   */
  usageProjection?: ReadOnlyProjection;
  reservationProjection?: ReadOnlyProjection;
  /** Injection token of the host's QuotaReservationService instance. */
  reservations: InjectionToken;
  /** Defaults: quota:query / quota:update. */
  permissions?: Partial<{ query: string; update: string }>;
  auditModule?: string;
  guards?: Type<CanActivate>[];
  maxPageSize?: number;
}

export const DEFAULT_QUOTA_USAGE_PROJECTION = {
  userId: 'subjectId',
  counter: 'counter',
  period: 'period',
  limit: 'limit',
  used: 'used',
  updatedAt: 'updatedAt',
} as const;
export const DEFAULT_QUOTA_RESERVATION_PROJECTION = {
  id: 'id',
  userId: 'subjectId',
  counter: 'counter',
  period: 'period',
  amount: 'amount',
  limit: 'limit',
  status: 'status',
  resourceType: 'resourceType',
  resourceId: 'resourceId',
  expiresAt: 'expiresAt',
  createdAt: 'createdAt',
  finishedAt: 'finishedAt',
  reason: 'reason',
} as const;
export const QUOTA_RESERVATION_STATUSES = ['RESERVED', 'CONFIRMED', 'RELEASED', 'EXPIRED'] as const;

export interface QuotaUsageAdminController {
  list(query: Record<string, unknown>): Promise<unknown>;
}
export interface QuotaReservationAdminController {
  list(query: Record<string, unknown>): Promise<unknown>;
  detail(id: string): Promise<unknown>;
  release(id: string, body: unknown): Promise<{ id: string; changed: boolean }>;
  confirm(id: string): Promise<{ id: string; changed: boolean }>;
}

/**
 * RFC 8.4 quota administration: projected usage and reservation lists, plus release/confirm
 * through the durable reservation state machine (never a direct status write).
 */
export function createQuotaAdminControllers(options: QuotaAdminOptions): {
  usage: Type<QuotaUsageAdminController>;
  reservations: Type<QuotaReservationAdminController>;
} {
  const permissions = { query: 'quota:query', update: 'quota:update', ...options.permissions };
  const module = options.auditModule ?? 'quota';
  const guards = options.guards ?? [JwtAuthGuard, PermissionsGuard];
  const usageReader = createReadOnlyRecordReader({
    model: options.usageModel ?? 'quotaUsage',
    filters: ['userId', 'counter', 'period'],
    orderBy: { updatedAt: 'desc' },
    maxPageSize: options.maxPageSize,
    projection: options.usageProjection ?? DEFAULT_QUOTA_USAGE_PROJECTION,
  });
  const reservationReader = createReadOnlyRecordReader({
    model: options.reservationModel ?? 'quotaReservation',
    filters: ['userId', 'counter', 'status', 'resourceType'],
    enumFilters: { status: QUOTA_RESERVATION_STATUSES },
    orderBy: { createdAt: 'desc' },
    maxPageSize: options.maxPageSize,
    projection: options.reservationProjection ?? DEFAULT_QUOTA_RESERVATION_PROJECTION,
  });

  @Controller(options.usagePath ?? 'management/quota-usage')
  @UseGuards(...guards)
  class QuotaUsageController implements QuotaUsageAdminController {
    constructor(@Inject(DATABASE_ADAPTER) readonly database: DatabaseAdapter) {}
    @Get()
    @Permissions(permissions.query)
    list(@Query() query: Record<string, unknown>) {
      return usageReader.findAll(this.database, query);
    }
  }

  @Controller(options.reservationsPath ?? 'management/quota-reservations')
  @UseGuards(...guards)
  class QuotaReservationController implements QuotaReservationAdminController {
    constructor(
      @Inject(DATABASE_ADAPTER) readonly database: DatabaseAdapter,
      @Inject(options.reservations) readonly reservations: QuotaReservationAdminPort,
    ) {}
    @Get()
    @Permissions(permissions.query)
    list(@Query() query: Record<string, unknown>) {
      return reservationReader.findAll(this.database, query);
    }
    @Get(':id')
    @Permissions(permissions.query)
    async detail(@Param('id') id: string) {
      const row = await reservationReader.findOne(this.database, id);
      if (!row) throw new NotFoundException('Reservation not found');
      return row;
    }
    @Post(':id/release')
    @HttpCode(200)
    @Permissions(permissions.update)
    @AccessLogger({ module, action: 'release', describe: '释放额度预留', logParameters: true })
    async release(@Param('id') id: string, @Body() body: unknown) {
      const reason = body && typeof body === 'object' ? (body as { reason?: unknown }).reason : undefined;
      if (reason !== undefined && (typeof reason !== 'string' || reason.length > 200))
        throw new BadRequestException('Invalid reason');
      const changed = await viaPort(() => this.reservations.release(id, reason ?? 'released-by-administrator'));
      return { id, changed };
    }
    @Post(':id/confirm')
    @HttpCode(200)
    @Permissions(permissions.update)
    @AccessLogger({ module, action: 'confirm', describe: '确认额度预留并计入用量' })
    async confirm(@Param('id') id: string) {
      const changed = await viaPort(() => this.reservations.confirm(id));
      return { id, changed };
    }
  }
  return { usage: QuotaUsageController, reservations: QuotaReservationController };
}
