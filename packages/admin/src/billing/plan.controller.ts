import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
  type CanActivate,
  type InjectionToken,
  type Type,
} from '@nestjs/common';
import { JwtAuthGuard, Permissions, PermissionsGuard } from '@zucker-framework/auth';
import { AccessLogger } from '@zucker-framework/logging';
import type { SubscriptionPlan } from '@zucker-framework/fe-types/back-office';
import { viaPort } from '../port-errors';

/** A plan as the port returns it; dates serialize to ISO strings on the wire. */
export type AdminPlanRecord = SubscriptionPlan<Date | string>;

/**
 * Plan administration port. `PlanCatalogService` from `@zucker-framework/payment` satisfies it;
 * write methods validate their raw input (`SubscriptionPlanWriteBody`) and reject with branded
 * port errors (invalid / not_found / conflict — including a stale `expectedRevision` — / referenced).
 */
export interface PlanAdminPort {
  list(options?: { listedOnly?: boolean }): Promise<AdminPlanRecord[]>;
  findById(id: string): Promise<AdminPlanRecord>;
  create(input: unknown): Promise<AdminPlanRecord>;
  update(id: string, input: unknown): Promise<AdminPlanRecord>;
  setStatus(id: string, status: unknown): Promise<AdminPlanRecord>;
  delete(id: string): Promise<void>;
}
export interface PlanAdminOptions {
  /** Default `management/plans`. */
  path?: string;
  service: InjectionToken;
  /** Defaults: plans:query / plans:add / plans:update / plans:delete. */
  permissions?: Partial<{ query: string; add: string; update: string; delete: string }>;
  auditModule?: string;
  guards?: Type<CanActivate>[];
}
export interface PlanAdminController {
  list(): Promise<AdminPlanRecord[]>;
  detail(id: string): Promise<AdminPlanRecord>;
  create(body: unknown): Promise<AdminPlanRecord>;
  update(id: string, body: unknown): Promise<AdminPlanRecord>;
  setStatus(id: string, body: unknown): Promise<AdminPlanRecord>;
  remove(id: string): Promise<{ deleted: true }>;
}

/** RFC 8.2 plan management: list/detail, create, update, list/unlist and unreferenced deletion. */
export function createPlanAdminController(options: PlanAdminOptions): Type<PlanAdminController> {
  const permissions = {
    query: 'plans:query',
    add: 'plans:add',
    update: 'plans:update',
    delete: 'plans:delete',
    ...options.permissions,
  };
  const module = options.auditModule ?? 'plans';

  @Controller(options.path ?? 'management/plans')
  @UseGuards(...(options.guards ?? [JwtAuthGuard, PermissionsGuard]))
  class PlanController implements PlanAdminController {
    constructor(@Inject(options.service) readonly plans: PlanAdminPort) {}

    @Get()
    @Permissions(permissions.query)
    list() {
      return viaPort(() => this.plans.list());
    }

    @Get(':id')
    @Permissions(permissions.query)
    detail(@Param('id') id: string) {
      return viaPort(() => this.plans.findById(id));
    }

    @Post()
    @Permissions(permissions.add)
    @AccessLogger({ module, action: 'create', describe: '创建套餐', logParameters: true })
    create(@Body() body: unknown) {
      return viaPort(() => this.plans.create(body));
    }

    @Put(':id')
    @Permissions(permissions.update)
    @AccessLogger({ module, action: 'update', describe: '更新套餐', logParameters: true })
    update(@Param('id') id: string, @Body() body: unknown) {
      return viaPort(() => this.plans.update(id, body));
    }

    @Patch(':id/status')
    @Permissions(permissions.update)
    @AccessLogger({ module, action: 'status', describe: '上架或下架套餐', logParameters: true })
    setStatus(@Param('id') id: string, @Body() body: unknown) {
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'status'))
        throw new BadRequestException('Body must be { status: boolean }');
      return viaPort(() => this.plans.setStatus(id, (body as { status?: unknown }).status));
    }

    @Delete(':id')
    @HttpCode(200)
    @Permissions(permissions.delete)
    @AccessLogger({ module, action: 'delete', describe: '删除未被引用的套餐' })
    async remove(@Param('id') id: string) {
      await viaPort(() => this.plans.delete(id));
      return { deleted: true as const };
    }
  }
  return PlanController;
}
