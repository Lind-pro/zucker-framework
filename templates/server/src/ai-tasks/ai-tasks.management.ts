import { BadRequestException, Controller, Get, Header, Inject, Param, Query, UseGuards } from '@nestjs/common';
import { Permissions } from '@zucker-framework/auth';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { RateLimit, RateLimitGuard } from '@zucker-framework/rate-limiter';
import { ApplicationDatabase } from '../database';

const KINDS = ['image', 'video', 'audio'];
const STATUSES = ['QUEUED', 'PROCESSING', 'WAITING_PROVIDER', 'RETRYING', 'COMPLETED', 'FAILED', 'CANCELLED'];
const PROMPT_LIMIT = 200;
/** Same projection as the package's owner view: a requeued row that has a provider task is waiting on the provider. */
const STATUS_SQL = `CASE WHEN j.status::text IN ('QUEUED','RETRYING') AND t."providerTaskId" IS NOT NULL THEN 'WAITING_PROVIDER' ELSE j.status::text END`;
const SELECT = `SELECT t.id, t."ownerId", t.kind, ${STATUS_SQL} AS status, t.model, t.cost, t."createdAt", t."providerId",
    LEFT(j.payload->'input'->>'prompt', ${PROMPT_LIMIT}) AS prompt,
    (SELECT COUNT(*)::int FROM ai_task_outputs AS o WHERE o."taskId"=t.id) AS "outputCount",
    j."errorCode", j."completedAt"
  FROM ai_tasks AS t JOIN async_jobs AS j ON j.id=t.id`;

interface Row { id: string; ownerId: string; kind: string; status: string; model: string; cost: number; createdAt: Date;
  providerId: string; prompt: string | null; outputCount: number; errorCode: string | null; completedAt: Date | null }

/**
 * Read-only AI task projection for the back office (WP 2.5 shape). Status and prompt live in the durable
 * row, so this joins `async_jobs` instead of using the single-model read-only controller. The prompt is
 * truncated; provider task ids, raw provider payloads, hold ids and storage keys are never selected.
 */
@Controller('management/ai-tasks')
@UseGuards(RateLimitGuard)
@RateLimit({ limiter: 'api-default', keyExtractor: '#userId' })
export class AITasksManagementController {
  constructor(@Inject(DATABASE_ADAPTER) private readonly database: ApplicationDatabase) {}

  @Get() @Permissions('ai-tasks:query') @Header('Cache-Control', 'private, no-store')
  async list(@Query() query: Record<string, unknown>) {
    const allowed = ['page', 'pageSize', 'id', 'ownerId', 'kind', 'status'];
    if (Object.keys(query).some(key => !allowed.includes(key))) throw new BadRequestException('Only configured equality filters are supported');
    const number = (value: unknown, fallback: number, max: number) => {
      if (value === undefined || value === '') return fallback;
      const parsed = Number(value);
      if (typeof value !== 'string' || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw new BadRequestException('Invalid page');
      return parsed;
    };
    const page = number(query.page, 1, 100_000), pageSize = number(query.pageSize, 20, 100);
    const filter = (key: string, values?: string[]) => {
      const value = query[key];
      if (value === undefined || value === '') return null;
      if (typeof value !== 'string' || value.length > 191 || (values && !values.includes(value))) throw new BadRequestException(`Invalid ${key} filter`);
      return value;
    };
    const params = [filter('id'), filter('ownerId'), filter('kind', KINDS), filter('status', STATUSES)];
    const where = `WHERE ($1::text IS NULL OR t.id=$1) AND ($2::text IS NULL OR t."ownerId"=$2) AND ($3::text IS NULL OR t.kind=$3)
      AND ($4::text IS NULL OR ${STATUS_SQL}=$4)`;
    return this.database.transaction(async tx => {
      const rows = await tx.query<Row>(`${SELECT} ${where} ORDER BY t."createdAt" DESC, t.id DESC LIMIT $5 OFFSET $6`,
        [...params, pageSize, (page - 1) * pageSize]);
      const total = await tx.query<{ total: number }>(`SELECT COUNT(*)::int AS total FROM ai_tasks AS t JOIN async_jobs AS j ON j.id=t.id ${where}`, params);
      return { data: rows.rows, total: total.rows[0]?.total ?? 0, page, pageSize };
    });
  }

  @Get(':id') @Permissions('ai-tasks:query') @Header('Cache-Control', 'private, no-store')
  async get(@Param('id') id: string) {
    if (id.length > 191) return null;
    return (await this.database.transaction(tx => tx.query<Row>(`${SELECT} WHERE t.id=$1`, [id]))).rows[0] ?? null;
  }
}
