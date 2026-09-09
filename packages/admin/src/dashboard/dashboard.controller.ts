/**
 * DashboardController — admin 后台仪表盘汇总接口
 *
 * 仪表盘统计：
 * - GET /dashboard/stats — 汇总统计（用户/角色/权限/额度 真实数据）
 */
import {
  Controller,
  Get,
  Inject,
  HttpCode,
  HttpStatus,
  UseGuards,
  Logger,
} from '@nestjs/common';
import { JwtAuthGuard, PermissionsGuard, Permissions } from '@zucker-framework/auth';
import { DATABASE_ADAPTER } from '@zucker-framework/crud';
import type { DatabaseAdapter } from '@zucker-framework/core';

export interface DashboardStats {
  userCount: number;
  roleCount: number;
  permissionCount: number;
  creditCount: number;
  onlineCount: number;
  menuCount: number;
}

@Controller('dashboard')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Permissions()
export class DashboardController {
  private readonly logger = new Logger(DashboardController.name);

  constructor(
    @Inject(DATABASE_ADAPTER) private readonly db: DatabaseAdapter,
  ) {}

  /**
   * GET /dashboard/stats — 汇总统计（真实数据聚合）
   */
  @Get('stats')
  @HttpCode(HttpStatus.OK)
  async getStats(): Promise<DashboardStats> {
    const [userCount, roleCount, permissionCount, creditCount, menuCount] =
      await Promise.all([
        this.db.model('users').count(),
        this.db.model('roles').count(),
        this.db.model('permissions').count(),
        this.safeCount('credits'),
        this.safeCount('menus'),
      ]);

    return {
      userCount,
      roleCount,
      permissionCount,
      creditCount,
      onlineCount: 0, // 需要 TokenService 查活跃 session 数
      menuCount,
    };
  }

  /** 安全计数 — 模型不存在时返回 0 */
  private async safeCount(modelName: string): Promise<number> {
    try {
      return await this.db.model(modelName).count();
    } catch {
      return 0;
    }
  }
}
