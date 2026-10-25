/** Default administrator dictionary CRUD; public aliases are normalized before persistence. */
import { Controller, Post, Put, Delete, Body, Param, HttpCode, HttpStatus, UseGuards, Inject, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { classifyError } from '@zucker-framework/core';
import { DictionaryService, DictionaryItemService } from '@zucker-framework/dictionary';
import type { Dictionary, DictionaryItem, DictionaryItemInput, DictionaryItemUpdate } from '@zucker-framework/dictionary';
import { JwtAuthGuard, PermissionsGuard, Permissions } from '@zucker-framework/auth';

interface PageResult<T> { data: T[]; total: number; pageIndex: number; pageSize: number }

function objectInput(body: unknown, allowed?: readonly string[]): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body) || allowed && Object.keys(body).some(key => !allowed.includes(key)))
    throw new BadRequestException('Invalid dictionary fields');
  return body as Record<string, unknown>;
}
function stringField(value: unknown, required: true): string;
function stringField(value: unknown, required: boolean): string | undefined;
function stringField(value: unknown, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new BadRequestException('A non-empty string is required');
  return value;
}
function dictionaryInput(body: unknown, create: boolean) {
  const input = objectInput(body, ['name', 'classified', 'describe']);
  const name = stringField(input.name, create), classified = stringField(input.classified, create);
  if (input.describe !== undefined && typeof input.describe !== 'string') throw new BadRequestException('Invalid dictionary description');
  if (!create && !Object.keys(input).length) throw new BadRequestException('No dictionary changes were supplied');
  return { ...(name === undefined ? {} : { name }), ...(classified === undefined ? {} : { classified }), ...(input.describe === undefined ? {} : { describe: input.describe as string }) };
}
function itemInput(body: unknown, create: boolean): DictionaryItemUpdate & { dictId?: string; parentId?: string } {
  const input = objectInput(body, ['text', 'label', 'name', 'value', 'ordinal', 'sortIndex', 'description', 'describe', 'status', 'properties', 'searchCode', 'valueType', ...(create ? ['dictId', 'parentId'] : [])]);
  const text = stringField(input.text ?? input.label ?? input.name, create), value = stringField(input.value, create);
  const dictId = create ? stringField(input.dictId, true) : undefined;
  const ordinal = input.ordinal ?? input.sortIndex, description = input.description ?? input.describe;
  if (ordinal !== undefined && (!Number.isInteger(ordinal) || Number(ordinal) < -2147483648 || Number(ordinal) > 2147483647)) throw new BadRequestException('Invalid dictionary item ordinal');
  if (description !== undefined && typeof description !== 'string') throw new BadRequestException('Invalid dictionary item description');
  if (input.status !== undefined && typeof input.status !== 'boolean') throw new BadRequestException('Invalid dictionary item status');
  if (input.properties !== undefined) objectInput(input.properties);
  for (const key of ['parentId', 'searchCode', 'valueType']) if (input[key] !== undefined) stringField(input[key], true);
  if (!create && !Object.keys(input).length) throw new BadRequestException('No dictionary item changes were supplied');
  return {
    ...(text === undefined ? {} : { text }), ...(value === undefined ? {} : { value }), ...(dictId === undefined ? {} : { dictId }),
    ...(ordinal === undefined ? {} : { ordinal: ordinal as number }), ...(description === undefined ? {} : { description: description as string }),
    ...(input.parentId === undefined ? {} : { parentId: input.parentId as string }), ...(input.status === undefined ? {} : { status: input.status as boolean }),
    ...(input.properties === undefined ? {} : { properties: input.properties as Record<string, unknown> }),
    ...(input.searchCode === undefined ? {} : { searchCode: input.searchCode as string }), ...(input.valueType === undefined ? {} : { valueType: input.valueType as string }),
  };
}
function queryInput(body: unknown, allowedFilters: readonly string[]) {
  const input = objectInput(body ?? {}, ['pageIndex', 'pageSize', 'filter']);
  const pageIndex = input.pageIndex ?? 0, requestedSize = input.pageSize ?? 20;
  if (!Number.isSafeInteger(pageIndex) || Number(pageIndex) < 0 || !Number.isSafeInteger(requestedSize) || Number(requestedSize) < 1) throw new BadRequestException('Invalid dictionary pagination');
  const filter: Record<string, string> = {};
  for (const [raw, value] of Object.entries(input.filter === undefined ? {} : objectInput(input.filter))) {
    const key = raw.endsWith('$eq') ? raw.slice(0, -3) : raw;
    if (!allowedFilters.includes(key)) throw new BadRequestException('Unsupported dictionary filter');
    const parsed = stringField(value, true);
    if (filter[key] !== undefined && filter[key] !== parsed) throw new BadRequestException('Conflicting dictionary filters');
    filter[key] = parsed;
  }
  return { pageIndex: Number(pageIndex), pageSize: Math.min(100, Number(requestedSize)), filter };
}
function page<T>(rows: T[], pageIndex: number, pageSize: number) {
  return { data: rows.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize), total: rows.length, pageIndex, pageSize };
}

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Permissions('dictionary:query')
@Controller()
export class DictionaryController {
  constructor(
    @Inject(DictionaryService) private readonly dictionaryService: DictionaryService,
    @Inject(DictionaryItemService) private readonly dictionaryItemService: DictionaryItemService,
  ) {}

  private async mutation<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch (error) {
      const result = classifyError(error);
      if (result.code === 'UNIQUE_CONSTRAINT') throw new ConflictException('This dictionary item value already exists in the dictionary');
      if (result.code === 'NOT_FOUND') throw new NotFoundException('Dictionary record not found');
      if (result.code === 'FOREIGN_KEY_CONSTRAINT') throw new BadRequestException('Referenced dictionary record does not exist');
      throw error;
    }
  }

  @Post('dictionary/_query')
  @HttpCode(HttpStatus.OK)
  async queryDictionaries(@Body() body: unknown): Promise<PageResult<Omit<Dictionary, 'items'>>> {
    const { pageIndex, pageSize, filter } = queryInput(body, ['name', 'classified']);
    const all = (await this.dictionaryService.findAll()).filter(row => Object.entries(filter).every(([key, value]) => row[key as 'name' | 'classified'] === value));
    return page(all.sort((a, b) => a.id.localeCompare(b.id)), pageIndex, pageSize);
  }

  @Post('dictionary')
  @HttpCode(HttpStatus.CREATED)
  @Permissions('dictionary:add')
  async createDictionary(@Body() body: unknown): Promise<Omit<Dictionary, 'items'>> {
    const input = dictionaryInput(body, true), name = stringField(input.name, true), classified = stringField(input.classified, true);
    return this.mutation(() => this.dictionaryService.create({ ...input, name, classified }));
  }

  @Put('dictionary/:id')
  @Permissions('dictionary:update')
  async updateDictionary(@Param('id') id: string, @Body() body: unknown): Promise<Omit<Dictionary, 'items'>> {
    const input = dictionaryInput(body, false);
    return this.mutation(() => this.dictionaryService.update(id, input));
  }

  @Delete('dictionary/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permissions('dictionary:delete')
  async deleteDictionary(@Param('id') id: string): Promise<void> {
    await this.mutation(() => this.dictionaryService.delete(id));
  }

  @Post('dictionary-item/_query')
  @HttpCode(HttpStatus.OK)
  async queryDictionaryItems(@Body() body: unknown): Promise<PageResult<DictionaryItem>> {
    const { pageIndex, pageSize, filter } = queryInput(body, ['dictId']);
    const all = await this.dictionaryItemService.findAll(filter);
    return page(all, pageIndex, pageSize);
  }

  @Post('dictionary-item')
  @HttpCode(HttpStatus.CREATED)
  @Permissions('dictionary:add')
  async createDictionaryItem(@Body() body: unknown): Promise<DictionaryItem> {
    const input = itemInput(body, true) as DictionaryItemInput;
    if (!await this.dictionaryService.findById(input.dictId)) throw new NotFoundException('Dictionary not found');
    return this.mutation(() => this.dictionaryItemService.create(input));
  }

  @Put('dictionary-item/:id')
  @Permissions('dictionary:update')
  async updateDictionaryItem(@Param('id') id: string, @Body() body: unknown): Promise<DictionaryItem> {
    const input = itemInput(body, false);
    return this.mutation(() => this.dictionaryItemService.update(id, input));
  }

  @Delete('dictionary-item/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permissions('dictionary:delete')
  async deleteDictionaryItem(@Param('id') id: string): Promise<void> {
    await this.mutation(() => this.dictionaryItemService.delete(id));
  }
}
