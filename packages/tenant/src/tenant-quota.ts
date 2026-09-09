import { Injectable, Logger } from '@nestjs/common';

/**
 * 租户配额管理。
 */
export interface TenantQuota {
  tenantId: string;
  /** 最大用户数 */
  maxUsers?: number;
  /** 最大存储空间（字节） */
  maxStorage?: number;
  /** 最大 API 调用次数/天 */
  maxApiCallsPerDay?: number;
  /** 自定义配额 */
  custom?: Record<string, number>;
}

export interface QuotaUsage {
  tenantId: string;
  currentUsers: number;
  currentStorage: number;
  apiCallsToday: number;
  custom?: Record<string, number>;
}

export interface QuotaCheckResult {
  allowed: boolean;
  resource: string;
  current: number;
  limit: number;
  message?: string;
}

@Injectable()
export class TenantQuotaManager {
  private readonly logger = new Logger(TenantQuotaManager.name);
  private readonly quotas = new Map<string, TenantQuota>();
  private readonly usage = new Map<string, QuotaUsage>();

  /** 设置租户配额 */
  setQuota(quota: TenantQuota): void {
    this.quotas.set(quota.tenantId, quota);
    this.logger.log(`Tenant quota set: ${quota.tenantId}`);
  }

  /** 获取租户配额 */
  getQuota(tenantId: string): TenantQuota | undefined {
    return this.quotas.get(tenantId);
  }

  /** 获取当前用量 */
  getUsage(tenantId: string): QuotaUsage {
    return this.usage.get(tenantId) ?? {
      tenantId,
      currentUsers: 0,
      currentStorage: 0,
      apiCallsToday: 0,
    };
  }

  /** 更新用量 */
  updateUsage(tenantId: string, partial: Partial<QuotaUsage>): void {
    const current = this.getUsage(tenantId);
    this.usage.set(tenantId, { ...current, ...partial, tenantId });
  }

  /** 检查某项资源是否超配额 */
  checkQuota(tenantId: string, resource: 'users' | 'storage' | 'apiCalls' | string, increment = 1): QuotaCheckResult {
    const quota = this.quotas.get(tenantId);
    if (!quota) return { allowed: true, resource, current: 0, limit: Infinity };

    const usage = this.getUsage(tenantId);

    switch (resource) {
      case 'users': {
        const limit = quota.maxUsers ?? Infinity;
        const current = usage.currentUsers;
        return { allowed: current + increment <= limit, resource, current, limit, message: current + increment > limit ? `用户数已达上限 (${limit})` : undefined };
      }
      case 'storage': {
        const limit = quota.maxStorage ?? Infinity;
        const current = usage.currentStorage;
        return { allowed: current + increment <= limit, resource, current, limit, message: current + increment > limit ? `存储空间已达上限` : undefined };
      }
      case 'apiCalls': {
        const limit = quota.maxApiCallsPerDay ?? Infinity;
        const current = usage.apiCallsToday;
        return { allowed: current + increment <= limit, resource, current, limit, message: current + increment > limit ? `今日 API 调用次数已达上限 (${limit})` : undefined };
      }
      default: {
        const limit = quota.custom?.[resource] ?? Infinity;
        const current = usage.custom?.[resource] ?? 0;
        return { allowed: current + increment <= limit, resource, current, limit };
      }
    }
  }

  /** 递增 API 调用计数 */
  incrementApiCalls(tenantId: string): void {
    const usage = this.getUsage(tenantId);
    usage.apiCallsToday++;
    this.usage.set(tenantId, usage);
  }

  /** 每日重置 API 调用计数 */
  resetDailyCounters(): void {
    for (const [tenantId, usage] of this.usage) {
      usage.apiCallsToday = 0;
      this.usage.set(tenantId, usage);
    }
  }

  /** 删除租户配额 */
  removeQuota(tenantId: string): void {
    this.quotas.delete(tenantId);
    this.usage.delete(tenantId);
  }
}

/**
 * 租户初始化模板 — 定义新租户创建时的默认资源。
 */
export interface TenantInitTemplate {
  id: string;
  name: string;
  /** 默认配额 */
  quota: Omit<TenantQuota, 'tenantId'>;
  /** 默认角色列表 */
  defaultRoles?: Array<{ name: string; permissions?: string[] }>;
  /** 默认菜单列表 */
  defaultMenus?: Array<{ name: string; path: string; icon?: string }>;
  /** 默认配置 */
  defaultConfig?: Record<string, unknown>;
}

@Injectable()
export class TenantTemplateManager {
  private readonly templates = new Map<string, TenantInitTemplate>();

  register(template: TenantInitTemplate): void {
    this.templates.set(template.id, template);
  }

  get(id: string): TenantInitTemplate | undefined {
    return this.templates.get(id);
  }

  getAll(): TenantInitTemplate[] {
    return Array.from(this.templates.values());
  }

  getDefault(): TenantInitTemplate | undefined {
    return this.templates.values().next().value;
  }
}
