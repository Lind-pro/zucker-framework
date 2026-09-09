/**
 * NotificationController — admin 后台通知管理接口
 *
 * 端点列表：
 * - POST /notification/template/_query  — 通知模板分页查询
 * - POST /notification/template         — 创建模板
 * - PUT  /notification/template/:id     — 更新模板
 * - DELETE /notification/template/:id   — 删除模板
 * - POST /notification/history/_query   — 发送历史分页查询
 */
import {
  Controller,
  Post,
  Put,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  UseGuards,
  Logger,
} from '@nestjs/common';
import { NotFoundException } from '@zucker-framework/core';
import { JwtAuthGuard, PermissionsGuard, Permissions } from '@zucker-framework/auth';
import {
  TemplateService,
  NotifyHistoryService,
  type TemplateProperties,
  type NotifyTemplate,
  type NotifyChannel,
  type NotifyHistoryRecord,
} from '@zucker-framework/notification';

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

interface HistoryQueryRequest {
  pageIndex?: number;
  pageSize?: number;
  channel?: NotifyChannel;
  to?: string;
  success?: boolean;
  startTime?: string;
  endTime?: string;
}

@Controller('notification')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Permissions()
export class NotificationController {
  private readonly logger = new Logger(NotificationController.name);

  constructor(
    private readonly templateService: TemplateService,
    private readonly notifyHistoryService: NotifyHistoryService,
  ) {}

  /**
   * POST /notification/template/_query — 通知模板分页查询
   * Body: { pageIndex?: number, pageSize?: number, filter?: Record<string, unknown> }
   */
  @Post('template/_query')
  @HttpCode(HttpStatus.OK)
  queryTemplates(@Body() body: QueryRequest): PageResult<NotifyTemplate> {
    const pageIndex = body.pageIndex ?? 0;
    const pageSize = body.pageSize ?? 10;
    const channelFilter = body.filter?.['channel'] as NotifyChannel | undefined;

    const all = this.templateService.listTemplates(channelFilter);
    const total = all.length;
    const start = pageIndex * pageSize;
    const data = all.slice(start, start + pageSize);

    return { data, total, pageIndex, pageSize };
  }

  /**
   * POST /notification/template — 创建模板
   */
  @Post('template')
  @HttpCode(HttpStatus.CREATED)
  createTemplate(@Body() body: TemplateProperties): NotifyTemplate {
    return this.templateService.createTemplate(body);
  }

  /**
   * PUT /notification/template/:id — 更新模板
   * TemplateService uses an in-memory Map; update = remove + recreate.
   */
  @Put('template/:id')
  updateTemplate(
    @Param('id') id: string,
    @Body() body: Partial<TemplateProperties>,
  ): NotifyTemplate {
    const existing = this.templateService.getTemplate(id);
    if (!existing) {
      throw new NotFoundException(`Template ${id} not found`);
    }
    // Merge existing with updated fields and recreate
    const merged: TemplateProperties = {
      id: existing.id,
      name: body.name ?? existing.name,
      channel: body.channel ?? existing.channel,
      provider: body.provider ?? existing.provider,
      content: body.content ?? existing.content,
      variableDefinitions: body.variableDefinitions ?? existing.variableDefinitions,
      configId: body.configId ?? existing.configId,
      description: body.description ?? existing.description,
    };
    this.templateService.remove(id);
    return this.templateService.createTemplate(merged);
  }

  /**
   * DELETE /notification/template/:id — 删除模板
   */
  @Delete('template/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeTemplate(@Param('id') id: string): void {
    const removed = this.templateService.remove(id);
    if (!removed) {
      throw new NotFoundException(`Template ${id} not found`);
    }
  }

  /**
   * POST /notification/history/_query — 发送历史分页查询
   * Body: { pageIndex?, pageSize?, channel?, to?, success?, startTime?, endTime? }
   */
  @Post('history/_query')
  @HttpCode(HttpStatus.OK)
  queryHistory(@Body() body: HistoryQueryRequest): PageResult<NotifyHistoryRecord> {
    const pageIndex = body.pageIndex ?? 0;
    const pageSize = body.pageSize ?? 10;

    // Query all matching records once, then slice — avoids a second DB/memory pass.
    // NotifyHistoryService is in-memory (max 10 000 records), so this is acceptable.
    const allRecords = this.notifyHistoryService.query({
      channel: body.channel,
      to: body.to,
      success: body.success,
      startTime: body.startTime ? new Date(body.startTime) : undefined,
      endTime: body.endTime ? new Date(body.endTime) : undefined,
    });

    const total = allRecords.length;
    const data = allRecords.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);

    return { data, total, pageIndex, pageSize };
  }
}
