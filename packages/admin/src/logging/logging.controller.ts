/**
 * Logging controller — admin API for access log queries.
 *
 * Endpoints:
 * - POST /logging/access/_query  — paginated in-memory access log list
 *
 * Implementation note:
 * @zucker-framework/logging's AccessLoggerInterceptor publishes events via ACCESS_LOG_BUS
 * (EventEmitter2); it does NOT persist logs to a database. This controller
 * maintains an in-memory ring buffer (max MAX_LOGS entries) populated via
 * @OnEvent(ACCESS_LOG_EVENT) and exposes it through the _query endpoint.
 *
 * For production use, replace the in-memory store with a database-backed
 * repository (e.g. Prisma) and store logs in the ACCESS_LOG_EVENT handler.
 */
import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { JwtAuthGuard, PermissionsGuard, Permissions } from '@zucker-framework/auth';
import { ACCESS_LOG_EVENT } from '@zucker-framework/logging';
import type { AccessLogPayload } from '@zucker-framework/logging';

/** Maximum number of log entries retained in memory */
const MAX_LOGS = 10_000;

interface PageResult<T> {
  data: T[];
  total: number;
  pageIndex: number;
  pageSize: number;
}

interface AccessLogQueryBody {
  pageIndex?: number;
  pageSize?: number;
  filter?: {
    userId?: string;
    method?: string;
    module?: string;
  };
}

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Permissions('logging:query')
@Controller('logging')
export class LoggingController {
  /** In-memory ring buffer of access log payloads */
  private readonly logs: AccessLogPayload[] = [];

  /**
   * Listen for access-log events emitted by AccessLoggerInterceptor and
   * append them to the in-memory buffer, capping at MAX_LOGS entries.
   */
  @OnEvent(ACCESS_LOG_EVENT)
  handleAccessLog(payload: AccessLogPayload): void {
    this.logs.push(payload);
    if (this.logs.length > MAX_LOGS) {
      // Remove oldest entry (FIFO)
      this.logs.shift();
    }
  }

  /**
   * POST /logging/access/_query
   * Returns a paginated slice of the in-memory access log buffer.
   * Supports optional filters: userId, method, module.
   */
  @Post('access/_query')
  @HttpCode(HttpStatus.OK)
  queryAccessLogs(
    @Body() body: AccessLogQueryBody,
  ): PageResult<AccessLogPayload> {
    const pageIndex = Math.max(0, body.pageIndex ?? 0);
    const pageSize = Math.min(200, Math.max(1, body.pageSize ?? 20));

    // Apply filters
    let filtered = this.logs as AccessLogPayload[];

    if (body.filter?.userId) {
      const uid = body.filter.userId;
      filtered = filtered.filter((l) => l.userId === uid);
    }
    if (body.filter?.method) {
      const method = body.filter.method.toUpperCase();
      filtered = filtered.filter((l) => l.method.toUpperCase() === method);
    }
    if (body.filter?.module) {
      const mod = body.filter.module;
      filtered = filtered.filter((l) => l.module === mod);
    }

    // Newest-first ordering
    const reversed = filtered.slice().reverse();

    const total = reversed.length;
    const start = pageIndex * pageSize;
    const data = reversed.slice(start, start + pageSize);

    return { data, total, pageIndex, pageSize };
  }
}
