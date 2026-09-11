import {
  Controller,
  Get,
  Inject,
  Param,
  Query,
  Res,
  Header,
  ParseIntPipe,
  DefaultValuePipe,
  UseGuards,
  type CanActivate,
  type Type,
} from '@nestjs/common';
import { JwtAuthGuard, PermissionsGuard, Permissions } from '@zucker-framework/auth';
import {
  AccessLogService,
  OperationLogService,
  type OperationLogStatus,
} from '@zucker-framework/logging';
import { buildAttachmentDisposition } from '@zucker-framework/common';

export interface LogQueryControllerOptions {
  path: string;
  permissions: { access: string; operation: string };
  guards?: Type<CanActivate>[];
  exportLabels?: { access: string; operation: string };
}
interface CsvResponse {
  setHeader(name: string, value: string): unknown;
  send(body: string): unknown;
}

/** Query, statistics and CSV routes backed by the same persistent audit services as management. */
export function createLogQueryController(options: LogQueryControllerOptions): Type<unknown> {
  @Controller(options.path)
  @UseGuards(...(options.guards ?? [JwtAuthGuard, PermissionsGuard]))
  class LogQueryController {
    constructor(
      @Inject(AccessLogService) readonly access: AccessLogService,
      @Inject(OperationLogService) readonly operation: OperationLogService,
    ) {}

    @Get('access')
    @Permissions(options.permissions.access)
    async getAccessLogs(
      @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
      @Query('pageSize', new DefaultValuePipe(20), ParseIntPipe) pageSize: number,
      @Query('userId') userId?: string,
      @Query('module') module?: string,
      @Query('action') action?: string,
      @Query('ip') ip?: string,
      @Query('startTime') startTime?: string,
      @Query('endTime') endTime?: string,
    ) {
      const result = await this.access.findAll({
        page,
        pageSize,
        userId,
        module,
        action,
        ip,
        startDate: startTime ? new Date(startTime) : undefined,
        endDate: endTime ? new Date(endTime) : undefined,
      });
      return { ...result, totalPages: Math.ceil(result.total / result.pageSize) };
    }

    @Get('access/ip-timeline/:ip')
    @Permissions(options.permissions.access)
    getIpTimeline(
      @Param('ip') ip: string,
      @Query('days', new DefaultValuePipe(7), ParseIntPipe) days: number,
    ) {
      return this.access.getIpTimeline(ip, days);
    }

    @Get('operation')
    @Permissions(options.permissions.operation)
    async getOperationLogs(
      @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
      @Query('pageSize', new DefaultValuePipe(20), ParseIntPipe) pageSize: number,
      @Query('userId') userId?: string,
      @Query('module') module?: string,
      @Query('action') action?: string,
      @Query('status') status?: OperationLogStatus,
      @Query('startTime') startTime?: string,
      @Query('endTime') endTime?: string,
    ) {
      const result = await this.operation.findAll({
        page,
        pageSize,
        userId,
        module,
        action,
        status,
        startDate: startTime ? new Date(startTime) : undefined,
        endDate: endTime ? new Date(endTime) : undefined,
      });
      return { ...result, totalPages: Math.ceil(result.total / result.pageSize) };
    }

    @Get('metrics')
    @Permissions(options.permissions.access)
    getMetrics() {
      return { accessLog: this.access.getMetrics(), operationLog: this.operation.getMetrics() };
    }

    @Get('statistics')
    @Permissions(options.permissions.access)
    async getStatistics(@Query('module') module?: string) {
      const [accessLog, operationLog] = module
        ? await Promise.all([
            this.access.getModuleStatistics(module),
            this.operation.getModuleStatistics(module),
          ])
        : [null, null];
      return { performance: this.getMetrics(), moduleStatistics: { accessLog, operationLog } };
    }

    @Get('access/export')
    @Permissions(options.permissions.access)
    @Header('Content-Type', 'text/csv; charset=utf-8')
    async exportAccessLogs(
      @Res() response: CsvResponse,
      @Query('userId') userId?: string,
      @Query('module') module?: string,
      @Query('action') action?: string,
      @Query('startTime') startTime?: string,
      @Query('endTime') endTime?: string,
      @Query('limit', new DefaultValuePipe(10000), ParseIntPipe) limit?: number,
    ) {
      const csv = await this.access.exportToCsv({
        userId,
        module,
        action,
        limit,
        startDate: startTime ? new Date(startTime) : undefined,
        endDate: endTime ? new Date(endTime) : undefined,
      });
      this.sendCsv(response, csv, 'access');
    }

    @Get('operation/export')
    @Permissions(options.permissions.operation)
    @Header('Content-Type', 'text/csv; charset=utf-8')
    async exportOperationLogs(
      @Res() response: CsvResponse,
      @Query('userId') userId?: string,
      @Query('module') module?: string,
      @Query('action') action?: string,
      @Query('status') status?: OperationLogStatus,
      @Query('startTime') startTime?: string,
      @Query('endTime') endTime?: string,
      @Query('limit', new DefaultValuePipe(10000), ParseIntPipe) limit?: number,
    ) {
      const csv = await this.operation.exportToCsv({
        userId,
        module,
        action,
        status,
        limit,
        startDate: startTime ? new Date(startTime) : undefined,
        endDate: endTime ? new Date(endTime) : undefined,
      });
      this.sendCsv(response, csv, 'operation');
    }

    private sendCsv(response: CsvResponse, csv: string, kind: 'access' | 'operation') {
      const day = new Date().toISOString().slice(0, 10);
      const fallback = `${kind}-log-${day}.csv`;
      const label = options.exportLabels?.[kind];
      response.setHeader(
        'Content-Disposition',
        buildAttachmentDisposition(label ? `${label}_${day}.csv` : fallback, fallback),
      );
      response.send('\uFEFF' + csv);
    }
  }
  return LogQueryController;
}
