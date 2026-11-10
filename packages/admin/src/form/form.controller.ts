/**
 * FormController — admin 后台表单引擎管理接口
 *
 * 端点列表：
 * - POST /form/definition/_query  — 表单定义分页查询
 * - GET  /form/definition/:id     — 查询单个表单定义
 * - POST /form/definition         — 创建表单定义
 * - PUT /form/definition/:id      — 更新表单定义
 * - DELETE /form/definition/:id   — 删除表单定义
 */
import {
  Controller,
  Get,
  Post,
  Put,
  BadRequestException,
  ConflictException,
  Delete,
  Body,
  Param,
  HttpCode,
  Inject,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { NotFoundException, classifyError } from '@zucker-framework/core';
import { JwtAuthGuard, PermissionsGuard, Permissions } from '@zucker-framework/auth';
import { FormService } from '@zucker-framework/form';
import type { FormDefinition, FieldDefinition } from '@zucker-framework/form';
import { adminPage, toAdminWhere, type AdminQueryFilterOptions } from '../query-filter';

/** Filterable form-definition fields (allow-list). */
export const FORM_FILTER: AdminQueryFilterOptions = { eq: ['id', 'name', 'version'], like: ['id', 'name', 'description'] };

/** Evaluates a `toAdminWhere` result (`field: scalar` or `{ contains, mode: 'insensitive' }`) in memory. */
function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([field, condition]) => {
    const value = row[field];
    if (condition && typeof condition === 'object' && 'contains' in condition) {
      return typeof value === 'string'
        && value.toLowerCase().includes(String((condition as { contains: unknown }).contains).toLowerCase());
    }
    return value === condition;
  });
}

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

function definitionInput(body: unknown, create: boolean): Partial<FormDefinition> {
  const allowed = create ? ['id', 'name', 'description', 'fields', 'layout', 'version'] : ['name', 'description', 'fields', 'layout'];
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) throw new BadRequestException('Invalid form definition fields');
  const input = body as Record<string, unknown>;
  if (create && typeof input.name !== 'string' || input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim())) throw new BadRequestException('A form name is required');
  if (input.id !== undefined && (typeof input.id !== 'string' || !input.id.trim())) throw new BadRequestException('Invalid form identifier');
  if (input.description !== undefined && typeof input.description !== 'string') throw new BadRequestException('Invalid form description');
  if (input.version !== undefined && (!Number.isSafeInteger(input.version) || Number(input.version) < 1)) throw new BadRequestException('Invalid form version');
  if (input.fields !== undefined) {
    if (!Array.isArray(input.fields)) throw new BadRequestException('Form fields must be an array');
    const keys = new Set<string>();
    for (const value of input.fields) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Invalid form field');
      const field = value as FieldDefinition;
      if ([field.key, field.name, field.type].some(value => typeof value !== 'string' || !value.trim()) || keys.has(field.key)
        || field.required !== undefined && typeof field.required !== 'boolean'
        || field.options !== undefined && (!Array.isArray(field.options) || field.options.some(option => !option || typeof option.label !== 'string' || !['string', 'number', 'boolean'].includes(typeof option.value)))
        || field.validators !== undefined && (!Array.isArray(field.validators) || field.validators.some(rule => !rule || typeof rule.type !== 'string' || rule.message !== undefined && typeof rule.message !== 'string')))
        throw new BadRequestException('Invalid or duplicate form field');
      keys.add(field.key);
    }
  }
  if (input.layout !== undefined && (!input.layout || typeof input.layout !== 'object' || Array.isArray(input.layout))) throw new BadRequestException('Invalid form layout');
  if (!create && !Object.keys(input).length) throw new BadRequestException('No form changes were supplied');
  return { ...input, ...(typeof input.name === 'string' ? { name: input.name.trim() } : {}) } as Partial<FormDefinition>;
}

@Controller('form')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Permissions('form:query')
export class FormController {
  constructor(@Inject(FormService) private readonly formService: FormService) {}

  private async mutation<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch (error) {
      const result = classifyError(error);
      if (result.code === 'UNIQUE_CONSTRAINT') throw new ConflictException('A form with these unique fields already exists');
      if (result.code === 'NOT_FOUND') throw new NotFoundException('Form definition not found');
      throw error;
    }
  }

  /**
   * POST /form/definition/_query — 表单定义分页查询
   * Body: { pageIndex?: number, pageSize?: number, filter?: Record<string, unknown> }
   */
  @Post('definition/_query')
  @HttpCode(HttpStatus.OK)
  async queryDefinitions(@Body() body: QueryRequest): Promise<PageResult<FormDefinition>> {
    const { pageIndex, pageSize } = adminPage(body);
    // Same allow-listed filter semantics as the database-backed admin lists, applied in memory.
    const where = toAdminWhere(body.filter, FORM_FILTER);

    const all = await this.formService.findAll();
    const filtered = all.filter((form) => matchesWhere(form as unknown as Record<string, unknown>, where));

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
  @Permissions('form:add')
  async create(@Body() body: unknown): Promise<FormDefinition> {
    const input = definitionInput(body, true), name = input.name;
    if (typeof name !== 'string') throw new BadRequestException('A form name is required');
    return this.mutation(() => this.formService.create({ ...input, id: input.id ?? randomUUID(), name, fields: input.fields ?? [], version: input.version ?? 1 }));
  }

  @Put('definition/:id')
  @Permissions('form:update')
  async update(@Param('id') id: string, @Body() body: unknown): Promise<FormDefinition> {
    const input = definitionInput(body, false), existing = await this.formService.findById(id);
    if (!existing) throw new NotFoundException(`Form definition ${id} not found`);
    // One persistent update keeps the definition and displayed revision together.
    return this.mutation(() => this.formService.update(id, { ...input, version: (existing.version ?? 0) + 1 }));
  }

  /**
   * DELETE /form/definition/:id — 删除表单定义
   */
  @Delete('definition/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permissions('form:delete')
  async remove(@Param('id') id: string): Promise<void> {
    const existing = await this.formService.findById(id);
    if (!existing) {
      throw new NotFoundException(`Form definition ${id} not found`);
    }
    await this.formService.delete(id);
  }
}
