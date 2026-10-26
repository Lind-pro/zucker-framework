/**
 * Credit controller — admin API for viewing credit transactions across all users.
 *
 * Endpoints:
 * - POST /credit/_query   — paginated credit transaction list (all users)
 * - POST /credit/_count   — total transaction count (Dashboard use)
 *
 * Uses CreditService.queryAll() / countAll() for cross-user queries with
 * DB-side pagination. When filter.userId is provided, results are scoped
 * to that user.
 */
import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { CreditService } from '@zucker-framework/credit';
import type { CreditTransactionRecord } from '@zucker-framework/credit';
import { JwtAuthGuard, PermissionsGuard, Permissions } from '@zucker-framework/auth';

interface PageResult<T> {
  data: T[];
  total: number;
  pageIndex: number;
  pageSize: number;
}

interface CreditAdminQueryBody {
  /** 1-based page number */
  pageIndex?: number;
  pageSize?: number;
  filter?: {
    /** Scope results to a single user */
    userId?: string;
  };
}

interface CreditCountResult {
  total: number;
}

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Permissions('credit:query')
@Controller('credit')
export class CreditController {
  constructor(private readonly creditService: CreditService) {}

  /**
   * POST /credit/_query
   *
   * Uses CreditService.queryAll() for cross-user queries with DB-side pagination.
   * When filter.userId is supplied, results are scoped to that user.
   */
  @Post('_query')
  @HttpCode(HttpStatus.OK)
  async queryTransactions(
    @Body() body: CreditAdminQueryBody,
  ): Promise<PageResult<CreditTransactionRecord>> {
    const pageIndex = Math.max(0, body.pageIndex ?? 0);
    const pageSize = Math.min(100, Math.max(1, body.pageSize ?? 20));

    const result = await this.creditService.queryAll({
      page: pageIndex + 1,
      pageSize,
      userId: body.filter?.userId,
    });

    return {
      data: result.transactions,
      total: result.total,
      pageIndex,
      pageSize: result.pageSize,
    };
  }

  /**
   * POST /credit/_count
   *
   * Returns total transaction count. Accepts an optional userId filter.
   */
  @Post('_count')
  @HttpCode(HttpStatus.OK)
  async countTransactions(
    @Body() body: { filter?: { userId?: string } },
  ): Promise<CreditCountResult> {
    const total = await this.creditService.countAll(body.filter);
    return { total };
  }
}
