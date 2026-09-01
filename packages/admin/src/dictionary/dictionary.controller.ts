/**
 * Dictionary controller — admin API for managing dictionaries and dictionary items.
 *
 * Endpoints:
 * - POST /dictionary/_query          — paginated dictionary list
 * - POST /dictionary                 — create a dictionary
 * - DELETE /dictionary/:id           — delete a dictionary
 * - POST /dictionary-item/_query     — paginated dictionary-item list (filter by dictId)
 * - POST /dictionary-item            — create a dictionary item
 * - DELETE /dictionary-item/:id      — delete a dictionary item
 */
import {
  Controller,
  Post,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { DictionaryService, DictionaryItemService } from '@zucker/dictionary';
import type { Dictionary, DictionaryItem } from '@zucker/dictionary';
import { JwtAuthGuard, PermissionsGuard, Permissions } from '@zucker/auth';

/** Generic paginated response shape used by all _query endpoints */
interface PageResult<T> {
  data: T[];
  total: number;
  pageIndex: number;
  pageSize: number;
}

interface DictionaryQueryBody {
  pageIndex?: number;
  pageSize?: number;
  /** Optional filter: e.g. { classified: 'system' } */
  filter?: Record<string, unknown>;
}

interface DictionaryItemQueryBody {
  pageIndex?: number;
  pageSize?: number;
  /** Must include dictId to scope items to a dictionary */
  filter?: { dictId?: string } & Record<string, unknown>;
}

interface CreateDictionaryBody {
  name: string;
  classified: string;
  describe?: string;
}

interface CreateDictionaryItemBody {
  dictId: string;
  name: string;
  value: string;
  text: string;
  parentId?: string;
  sortIndex?: number;
  description?: string;
  status?: boolean;
  properties?: Record<string, unknown>;
  searchCode?: string;
  valueType?: string;
}

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Permissions()
@Controller()
export class DictionaryController {
  constructor(
    private readonly dictionaryService: DictionaryService,
    private readonly dictionaryItemService: DictionaryItemService,
  ) {}

  // ─── Dictionary endpoints ───────────────────────────────────────────────

  @Post('dictionary/_query')
  @HttpCode(HttpStatus.OK)
  async queryDictionaries(
    @Body() body: DictionaryQueryBody,
  ): Promise<PageResult<Dictionary>> {
    const pageIndex = Math.max(0, body.pageIndex ?? 0);
    const pageSize = Math.min(100, Math.max(1, body.pageSize ?? 20));

    // DictionaryService.findAll() returns all rows; we paginate in-process.
    // For production volumes, add a paginated DB query to DictionaryService.
    const all = await this.dictionaryService.findAll();

    // Apply classified filter if present
    const classified = body.filter?.['classified'];
    const filtered =
      typeof classified === 'string'
        ? all.filter((d) => d.classified === classified)
        : all;

    const total = filtered.length;
    const start = pageIndex * pageSize;
    const data = filtered.slice(start, start + pageSize) as Dictionary[];

    return { data, total, pageIndex, pageSize };
  }

  @Post('dictionary')
  @HttpCode(HttpStatus.CREATED)
  async createDictionary(
    @Body() body: CreateDictionaryBody,
  ): Promise<Dictionary> {
    const result = await this.dictionaryService.create({
      name: body.name,
      classified: body.classified,
      describe: body.describe,
    });
    return result as Dictionary;
  }

  @Delete('dictionary/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteDictionary(@Param('id') id: string): Promise<void> {
    await this.dictionaryService.delete(id);
  }

  // ─── Dictionary-item endpoints ───────────────────────────────────────────

  @Post('dictionary-item/_query')
  @HttpCode(HttpStatus.OK)
  async queryDictionaryItems(
    @Body() body: DictionaryItemQueryBody,
  ): Promise<PageResult<DictionaryItem>> {
    const pageIndex = Math.max(0, body.pageIndex ?? 0);
    const pageSize = Math.min(100, Math.max(1, body.pageSize ?? 20));

    const dictId = body.filter?.dictId;

    const all = await this.dictionaryItemService.findAll(
      dictId ? { dictId } : undefined,
    );
    const total = all.length;
    const start = pageIndex * pageSize;
    const data = all.slice(start, start + pageSize);

    return { data, total, pageIndex, pageSize };
  }

  @Post('dictionary-item')
  @HttpCode(HttpStatus.CREATED)
  async createDictionaryItem(
    @Body() body: CreateDictionaryItemBody,
  ): Promise<DictionaryItem> {
    return this.dictionaryItemService.create(body);
  }

  @Delete('dictionary-item/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteDictionaryItem(@Param('id') id: string): Promise<void> {
    await this.dictionaryItemService.delete(id);
  }
}
