import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  Req,
  SetMetadata,
  UseGuards,
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { AlertManagerService } from './alert-manager.service';
import type { AlertRule, AlertSeverity } from './alert.interfaces';
import {
  MONITORING_ACCESS_KIND,
  MONITORING_QUERY_PERMISSION,
  MONITORING_UPDATE_PERMISSION,
  MonitoringAccessGuard,
  MonitoringPermissions,
} from '../monitoring-access';

/** Upper bound on registered rules accepted through the HTTP API. */
export const MAX_ALERT_RULES = 500;

const CONDITIONS: ReadonlyArray<AlertRule['condition']> = ['>', '>=', '<', '<=', '==', '!='];
const SEVERITIES: ReadonlyArray<AlertSeverity> = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const METRIC_PATTERN = /^[A-Za-z_:][A-Za-z0-9_:.-]{0,199}$/;

/**
 * AlertController — 告警管理接口
 *
 * Mounted only by `ZuckerMonitoringModule.forRoot({ alerts: true })`. Fails closed through
 * `MonitoringAccessGuard` (requires an authenticated `request.user`), and carries
 * `monitoring:query` (reads) / `monitoring:update` (writes) permission metadata for the host's
 * PermissionsGuard. The acting user is always taken from the authenticated request.
 */
@Controller('monitoring/alerts')
@UseGuards(MonitoringAccessGuard)
@MonitoringPermissions(MONITORING_QUERY_PERMISSION)
@SetMetadata(MONITORING_ACCESS_KIND, 'alerts:read')
export class AlertController {
  constructor(private readonly alertManager: AlertManagerService) {}

  // ─── 告警列表 ───────────────────────────────────────

  @Get()
  getAlerts() {
    return this.alertManager.getAlerts();
  }

  // ─── 规则管理 ───────────────────────────────────────

  @Get('rules')
  getRules() {
    return this.alertManager.getRules();
  }

  @Post('rules')
  @HttpCode(HttpStatus.CREATED)
  @MonitoringPermissions(MONITORING_UPDATE_PERMISSION)
  @SetMetadata(MONITORING_ACCESS_KIND, 'alerts:write')
  createRule(@Body() body: unknown) {
    const rule = parseAlertRule(body);
    if (!this.alertManager.getRule(rule.id) && this.alertManager.getRules().length >= MAX_ALERT_RULES) {
      throw new BadRequestException(`At most ${MAX_ALERT_RULES} alert rules are allowed`);
    }
    this.alertManager.registerRule(rule);
    return rule;
  }

  @Delete('rules/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @MonitoringPermissions(MONITORING_UPDATE_PERMISSION)
  @SetMetadata(MONITORING_ACCESS_KIND, 'alerts:write')
  deleteRule(@Param('id') id: string) {
    const removed = this.alertManager.removeRule(id);
    if (!removed) {
      throw new NotFoundException(`Rule ${id} not found`);
    }
  }

  // ─── 告警操作 ───────────────────────────────────────

  @Put(':id/acknowledge')
  @MonitoringPermissions(MONITORING_UPDATE_PERMISSION)
  @SetMetadata(MONITORING_ACCESS_KIND, 'alerts:write')
  acknowledgeAlert(@Param('id') id: string, @Req() request: { user?: { id?: unknown } }) {
    const result = this.alertManager.acknowledgeAlert(id, actorOf(request));
    if (!result) {
      throw new NotFoundException(`Alert ${id} not found or not in ACTIVE status`);
    }
    return result;
  }

  @Put(':id/resolve')
  @MonitoringPermissions(MONITORING_UPDATE_PERMISSION)
  @SetMetadata(MONITORING_ACCESS_KIND, 'alerts:write')
  resolveAlert(@Param('id') id: string, @Req() request: { user?: { id?: unknown } }) {
    const result = this.alertManager.resolveAlert(id, actorOf(request));
    if (!result) {
      throw new NotFoundException(`Alert ${id} not found or already resolved`);
    }
    return result;
  }
}

/** The actor is the authenticated user; a body-supplied `userId` is ignored (it was spoofable). */
function actorOf(request: { user?: { id?: unknown } }): string {
  const id = request.user?.id;
  if ((typeof id !== 'string' || !id) && typeof id !== 'number') {
    throw new UnauthorizedException('Authentication required');
  }
  return String(id);
}

/** Validates and normalizes an untrusted alert rule body. */
export function parseAlertRule(body: unknown): AlertRule {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('Alert rule must be an object');
  }
  const input = body as Record<string, unknown>;
  const fail = (message: string): never => {
    throw new BadRequestException(message);
  };
  if (typeof input.id !== 'string' || !ID_PATTERN.test(input.id)) {
    fail('id must be 1-128 characters of letters, digits, ".", "_", ":" or "-"');
  }
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200) {
    fail('name must be a non-empty string of at most 200 characters');
  }
  if (typeof input.metric !== 'string' || !METRIC_PATTERN.test(input.metric)) {
    fail('metric must be a metric name of at most 200 characters');
  }
  if (typeof input.threshold !== 'number' || !Number.isFinite(input.threshold)) {
    fail('threshold must be a finite number');
  }
  const condition = input.condition ?? '>';
  if (!CONDITIONS.includes(condition as AlertRule['condition'])) {
    fail(`condition must be one of ${CONDITIONS.join(' ')}`);
  }
  const duration = input.duration ?? 0;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0 || duration > 31_536_000) {
    fail('duration must be a number of seconds between 0 and 31536000');
  }
  const severity = input.severity ?? 'MEDIUM';
  if (!SEVERITIES.includes(severity as AlertSeverity)) {
    fail(`severity must be one of ${SEVERITIES.join(', ')}`);
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    fail('enabled must be a boolean');
  }
  let notifyChannels: string[] | undefined;
  if (input.notifyChannels !== undefined) {
    if (
      !Array.isArray(input.notifyChannels) ||
      input.notifyChannels.length > 20 ||
      !input.notifyChannels.every((channel) => typeof channel === 'string' && channel.length > 0 && channel.length <= 100)
    ) {
      fail('notifyChannels must be at most 20 non-empty strings of at most 100 characters');
    }
    notifyChannels = [...(input.notifyChannels as string[])];
  }
  return {
    id: input.id as string,
    name: (input.name as string).trim(),
    metric: input.metric as string,
    condition: condition as AlertRule['condition'],
    threshold: input.threshold as number,
    duration: duration as number,
    severity: severity as AlertSeverity,
    enabled: input.enabled !== false,
    notifyChannels,
  };
}
