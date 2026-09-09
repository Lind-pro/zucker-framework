/**
 * TenantManagementController — admin 后台租户管理接口
 *
 * 注意：@zucker-framework/tenant 是多租户隔离基础设施（context、guard），
 * 不提供租户记录的 CRUD service。此模块通过 TENANT_STORE token 注入存储层。
 *
 * 端点列表：
 * - POST /tenant/_query  — 租户分页查询
 * - POST /tenant         — 创建租户
 * - PUT  /tenant/:id     — 更新租户
 * - DELETE /tenant/:id   — 删除租户
 */
import {
  Controller,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Inject,
  HttpCode,
  HttpStatus,
  UseGuards,
  Logger,
} from '@nestjs/common';
import { NotFoundException } from '@zucker-framework/core';
import { JwtAuthGuard, PermissionsGuard, Permissions } from '@zucker-framework/auth';
import {
  TENANT_STORE,
  type TenantStoreInterface,
  type TenantRecord,
  type CreateTenantRequest,
  type UpdateTenantRequest,
} from './tenant.store';

export type { TenantRecord, CreateTenantRequest, UpdateTenantRequest };

interface QueryRequest {
  pageIndex?: number;
  pageSize?: number;
  filter?: Record<string, unknown>;
}

interface PageResult<T> {
  data: T[];
  total: number;
  pageIndex: number;
  pageSize: number;
}

@Controller('tenant')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Permissions()
export class TenantManagementController {
  private readonly logger = new Logger(TenantManagementController.name);

  constructor(@Inject(TENANT_STORE) private readonly tenantStore: TenantStoreInterface) {}

  /**
   * POST /tenant/_query — 租户分页查询
   * Body: { pageIndex?, pageSize?, filter?: Record<string, unknown> }
   */
  @Post('_query')
  @HttpCode(HttpStatus.OK)
  query(@Body() body: QueryRequest): PageResult<TenantRecord> {
    const pageIndex = body.pageIndex ?? 0;
    const pageSize = body.pageSize ?? 10;

    const all = this.tenantStore.list(body.filter);
    const total = all.length;
    const start = pageIndex * pageSize;
    const data = all.slice(start, start + pageSize);

    return { data, total, pageIndex, pageSize };
  }

  /**
   * POST /tenant — 创建租户
   * Body: { name: string, code: string, description?: string, enabled?: boolean }
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() body: CreateTenantRequest): TenantRecord {
    return this.tenantStore.create(body);
  }

  /**
   * PUT /tenant/:id — 更新租户
   */
  @Put(':id')
  update(
    @Param('id') id: string,
    @Body() body: UpdateTenantRequest,
  ): TenantRecord {
    const updated = this.tenantStore.update(id, body);
    if (!updated) {
      throw new NotFoundException(`Tenant ${id} not found`);
    }
    return updated;
  }

  /**
   * DELETE /tenant/:id — 删除租户
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string): void {
    const deleted = this.tenantStore.delete(id);
    if (!deleted) {
      throw new NotFoundException(`Tenant ${id} not found`);
    }
  }
}
