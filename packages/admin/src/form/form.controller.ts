/**
 * FormController — admin 后台表单引擎管理接口
 *
 * 端点列表：
 * - POST /form/definition/_query  — 表单定义分页查询
 * - GET  /form/definition/:id     — 查询单个表单定义
 * - POST /form/definition         — 创建表单定义
 * - DELETE /form/definition/:id   — 删除表单定义
 */
import {
  Controller,
  Get,
  Post,
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
import { FormService } from '@zucker-framework/form';
import type { FormDefinition } from '@zucker-framework/form';

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

@Controller('form')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Permissions()
export class FormController {
  private readonly logger = new Logger(FormController.name);

  constructor(private readonly formService: FormService) {}

  /**
   * POST /form/definition/_query — 表单定义分页查询
   * Body: { pageIndex?: number, pageSize?: number, filter?: Record<string, unknown> }
   */
  @Post('definition/_query')
  @HttpCode(HttpStatus.OK)
  async queryDefinitions(@Body() body: QueryRequest): Promise<PageResult<FormDefinition>> {
    const pageIndex = body.pageIndex ?? 0;
    const pageSize = body.pageSize ?? 10;

    const all = await this.formService.findAll();

    // Client-side filter: apply simple key=value matching from body.filter
    const filter = body.filter ?? {};
    const filtered = all.filter((form) =>
      Object.entries(filter).every(([key, value]) => (form as unknown as Record<string, unknown>)[key] === value),
    );

    const total = filtered.length;
    const start = pageIndex * pageSize;
    const data = filtered.slice(start, start + pageSize);

    return { data, total, pageIndex, pageSize };
  }

  /**
   * GET /form/definition/:id — 查询单个表单定义
   */
  @Get('definition/:id')
  async findOne(@Param('id') id: string): Promise<FormDefinition> {
    const form = await this.formService.findById(id);
    if (!form) {
      throw new NotFoundException(`Form definition ${id} not found`);
    }
    return form;
  }

  /**
   * POST /form/definition — 创建表单定义
   */
  @Post('definition')
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: FormDefinition): Promise<FormDefinition> {
    return this.formService.create(body);
  }

  /**
   * DELETE /form/definition/:id — 删除表单定义
   */
  @Delete('definition/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string): Promise<void> {
    const existing = await this.formService.findById(id);
    if (!existing) {
      throw new NotFoundException(`Form definition ${id} not found`);
    }
    await this.formService.delete(id);
  }
}
