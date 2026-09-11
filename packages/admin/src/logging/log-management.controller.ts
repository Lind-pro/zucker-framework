import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
  type CanActivate,
  type Type,
} from '@nestjs/common';
import {
  JwtAuthGuard,
  PermissionsGuard,
  QueryAction,
  DeleteAction,
  Resource,
} from '@zucker-framework/auth';
import {
  AccessLogger,
  AccessLogService,
  OperationLogService,
  type LogQuery,
} from '@zucker-framework/logging';

export interface LogManagementOptions {
  path: string;
  resource: Parameters<typeof Resource>[0];
  /** Omit to use Framework guards; use [] when equivalent guards are already global. */
  guards?: Type<CanActivate>[];
  auditModule: string;
}
interface HttpLogQuery {
  module?: string;
  action?: string;
  userId?: string;
  ip?: string;
  status?: LogQuery['status'];
  startDate?: string;
  endDate?: string;
  page?: string;
  pageSize?: string;
}

function positiveInteger(value: string | number | undefined, fallback: number) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1)
    throw new BadRequestException('Expected a positive integer');
  return number;
}
function date(value?: string) {
  if (!value) return undefined;
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) throw new BadRequestException('Invalid date');
  return result;
}

/** Persisted audit management; only route names, permission resources and audit labels come from the host. */
function createController(
  kind: 'access' | 'operation',
  options: LogManagementOptions,
): Type<unknown> {
  const Service = kind === 'access' ? AccessLogService : OperationLogService;
  class LogController {
    constructor(@Inject(Service) readonly service: AccessLogService | OperationLogService) {}

    @Get()
    @QueryAction()
    findAll(@Query() query: HttpLogQuery) {
      if (query.status && !['SUCCESS', 'FAILED', 'PENDING'].includes(query.status))
        throw new BadRequestException('Invalid operation status');
      return this.service.findAll({
        module: query.module,
        action: query.action,
        userId: query.userId,
        ...(kind === 'access' ? { ip: query.ip } : { status: query.status }),
        startDate: date(query.startDate),
        endDate: date(query.endDate),
        page: positiveInteger(query.page, 1),
        pageSize: positiveInteger(query.pageSize, 20),
      });
    }

    @Get('statistics/:module')
    @QueryAction()
    statistics(@Param('module') module: string) {
      return this.service.getModuleStatistics(module);
    }

    @Get(':id')
    @QueryAction()
    findOne(@Param('id') id: string) {
      return this.service.findOne(id);
    }

    @Post('batch-delete')
    @DeleteAction()
    @AccessLogger({
      describe: '批量删除日志',
      module: options.auditModule,
      action: 'batchDelete',
      targetType: kind === 'access' ? 'AccessLog' : 'OperationLog',
      logParameters: true,
      logResult: true,
    })
    batchDelete(@Body() body: { ids?: string[] }) {
      if (
        !Array.isArray(body?.ids) ||
        !body.ids.length ||
        body.ids.length > 1000 ||
        body.ids.some((id) => typeof id !== 'string' || !id.trim())
      ) {
        throw new BadRequestException('Provide between 1 and 1000 log IDs');
      }
      return this.service.batchDelete(body.ids);
    }

    @Post('clean-old-logs')
    @DeleteAction()
    @AccessLogger({
      describe: '清理旧日志',
      module: options.auditModule,
      action: 'cleanOldLogs',
      targetType: kind === 'access' ? 'AccessLog' : 'OperationLog',
      logParameters: true,
      logResult: true,
    })
    cleanOldLogs(@Body() body: { daysToKeep?: number }) {
      return this.service.cleanOldLogs(positiveInteger(body?.daysToKeep || 90, 90));
    }
  }

  if (kind === 'access') {
    @Controller(options.path)
    @Resource(options.resource)
    @UseGuards(...(options.guards ?? [JwtAuthGuard, PermissionsGuard]))
    class AccessLogController extends LogController {
      @Get('ip-timeline/:ip')
      @QueryAction()
      timeline(@Param('ip') ip: string, @Query('days') days?: string) {
        return (this.service as AccessLogService).getIpTimeline(ip, positiveInteger(days, 7));
      }
    }
    return AccessLogController;
  }

  @Controller(options.path)
  @Resource(options.resource)
  @UseGuards(...(options.guards ?? [JwtAuthGuard, PermissionsGuard]))
  class OperationLogController extends LogController {}
  return OperationLogController;
}

export function createAccessLogAdminController(options: LogManagementOptions): Type<unknown> {
  return createController('access', options);
}
export function createOperationLogAdminController(options: LogManagementOptions): Type<unknown> {
  return createController('operation', options);
}
