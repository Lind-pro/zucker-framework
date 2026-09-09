/**
 * I18nManagementController — admin 后台国际化条目管理接口
 *
 * 注意：@zucker-framework/i18n 是基础设施包（locale context、FileMessageSource），
 * 不提供 i18n key 的 CRUD service。此模块通过 I18N_STORE token 注入存储层。
 *
 * 端点列表：
 * - POST /i18n/_query  — i18n 条目分页查询
 * - POST /i18n         — 创建条目
 * - PUT  /i18n/:id     — 更新条目
 */
import {
  Controller,
  Post,
  Put,
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
  I18N_STORE,
  type I18nStoreInterface,
  type I18nEntry,
  type CreateI18nEntryRequest,
  type UpdateI18nEntryRequest,
} from './i18n.store';

export type { I18nEntry, CreateI18nEntryRequest, UpdateI18nEntryRequest };

interface QueryRequest {
  pageIndex?: number;
  pageSize?: number;
  filter?: {
    code?: string;
    locale?: string;
  };
}

interface PageResult<T> {
  data: T[];
  total: number;
  pageIndex: number;
  pageSize: number;
}

@Controller('i18n')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Permissions()
export class I18nManagementController {
  private readonly logger = new Logger(I18nManagementController.name);

  constructor(@Inject(I18N_STORE) private readonly i18nStore: I18nStoreInterface) {}

  /**
   * POST /i18n/_query — i18n 条目分页查询
   * Body: { pageIndex?, pageSize?, filter?: { code?, locale? } }
   */
  @Post('_query')
  @HttpCode(HttpStatus.OK)
  query(@Body() body: QueryRequest): PageResult<I18nEntry> {
    const pageIndex = body.pageIndex ?? 0;
    const pageSize = body.pageSize ?? 10;

    const all = this.i18nStore.list(body.filter);
    const total = all.length;
    const start = pageIndex * pageSize;
    const data = all.slice(start, start + pageSize);

    return { data, total, pageIndex, pageSize };
  }

  /**
   * POST /i18n — 创建 i18n 条目
   * Body: { code: string, translations: Record<string, string> }
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() body: CreateI18nEntryRequest): I18nEntry {
    return this.i18nStore.create(body);
  }

  /**
   * PUT /i18n/:id — 更新 i18n 条目
   * Body: { code?: string, translations?: Record<string, string> }
   */
  @Put(':id')
  update(
    @Param('id') id: string,
    @Body() body: UpdateI18nEntryRequest,
  ): I18nEntry {
    const updated = this.i18nStore.update(id, body);
    if (!updated) {
      throw new NotFoundException(`I18n entry ${id} not found`);
    }
    return updated;
  }
}
