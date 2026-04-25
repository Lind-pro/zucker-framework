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
  SetMetadata,
  BadRequestException,
} from '@nestjs/common';
import { NotFoundException } from '@zucker/core';
import { AlertManagerService } from './alert-manager.service';

/** 标记需要认证但不需要特定权限（等效于 @zucker/auth 的 @Permissions()） */
const Permissions = () => SetMetadata('zucker:auth:permissions', []);
import type { AlertRule } from './alert.interfaces';

/**
 * AlertController — 告警管理接口
 *
 * 注意：本 Controller 不自带认证 Guard（monitoring 包不依赖 @zucker/auth）。
 * 应用层应通过以下方式之一保护这些端点：
 * 1. 全局 APP_GUARD（推荐 — 在 main.ts 或 AppModule 中注册 JwtAuthGuard）
 * 2. 在注册 ZuckerMonitoringModule 时，通过路由中间件添加认证
 */
@Controller('monitoring/alerts')
@Permissions()
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
  createRule(@Body() body: AlertRule) {
    if (!body.id || !body.name || !body.metric || body.threshold === undefined) {
      throw new BadRequestException(
        'Missing required fields: id, name, metric, threshold',
      );
    }
    const rule: AlertRule = {
      id: body.id,
      name: body.name,
      metric: body.metric,
      condition: body.condition ?? '>',
      threshold: body.threshold,
      duration: body.duration ?? 0,
      severity: body.severity ?? 'MEDIUM',
      enabled: body.enabled !== false,
      notifyChannels: body.notifyChannels,
    };
    this.alertManager.registerRule(rule);
    return rule;
  }

  @Delete('rules/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteRule(@Param('id') id: string) {
    const removed = this.alertManager.removeRule(id);
    if (!removed) {
      throw new NotFoundException(`Rule ${id} not found`);
    }
  }

  // ─── 告警操作 ───────────────────────────────────────

  @Put(':id/acknowledge')
  acknowledgeAlert(
    @Param('id') id: string,
    @Body('userId') userId: string,
  ) {
    if (!userId) {
      throw new BadRequestException('userId is required');
    }
    const result = this.alertManager.acknowledgeAlert(id, userId);
    if (!result) {
      throw new NotFoundException(
        `Alert ${id} not found or not in ACTIVE status`,
      );
    }
    return result;
  }

  @Put(':id/resolve')
  resolveAlert(
    @Param('id') id: string,
    @Body('userId') userId: string,
  ) {
    if (!userId) {
      throw new BadRequestException('userId is required');
    }
    const result = this.alertManager.resolveAlert(id, userId);
    if (!result) {
      throw new NotFoundException(
        `Alert ${id} not found or already resolved`,
      );
    }
    return result;
  }
}
