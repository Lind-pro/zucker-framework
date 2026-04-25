import { Injectable, Logger } from '@nestjs/common';

/**
 * 动态限流规则管理。
 * 对标 hsweb RateLimitManager 的动态调整能力。
 *
 * 支持运行时修改限流规则，无需重启服务。
 */
export interface DynamicLimiterRule {
  id: string;
  /** 限流器名称 */
  limiter: string;
  /** 匹配的路径模式 (glob) */
  pathPattern?: string;
  /** 匹配的用户角色 */
  roles?: string[];
  /** 每窗口最大请求数 */
  points: number;
  /** 时间窗口（秒） */
  duration: number;
  /** 是否启用 */
  enabled: boolean;
  /** 优先级（高优先级规则优先匹配） */
  priority?: number;
  /** 创建时间 */
  createdAt?: number;
}

@Injectable()
export class DynamicLimiterManager {
  private readonly logger = new Logger(DynamicLimiterManager.name);
  private readonly rules = new Map<string, DynamicLimiterRule>();
  private readonly listeners: Array<(rules: DynamicLimiterRule[]) => void> = [];

  /** 添加或更新限流规则 */
  setRule(rule: DynamicLimiterRule): void {
    rule.createdAt = rule.createdAt ?? Date.now();
    this.rules.set(rule.id, rule);
    this.notifyListeners();
    this.logger.log(`Dynamic limiter rule set: ${rule.id} (${rule.points}/${rule.duration}s)`);
  }

  /** 删除限流规则 */
  removeRule(id: string): boolean {
    const removed = this.rules.delete(id);
    if (removed) {
      this.notifyListeners();
      this.logger.log(`Dynamic limiter rule removed: ${id}`);
    }
    return removed;
  }

  /** 获取所有规则（按优先级排序） */
  getRules(): DynamicLimiterRule[] {
    return Array.from(this.rules.values())
      .filter(r => r.enabled)
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  /** 根据路径和角色匹配限流规则 */
  matchRule(path: string, roles?: string[]): DynamicLimiterRule | undefined {
    for (const rule of this.getRules()) {
      if (rule.pathPattern) {
        const regex = this.globToRegex(rule.pathPattern);
        if (!regex.test(path)) continue;
      }
      if (rule.roles?.length) {
        if (!roles?.some(r => rule.roles!.includes(r))) continue;
      }
      return rule;
    }
    return undefined;
  }

  /** 批量导入规则 */
  importRules(rules: DynamicLimiterRule[]): void {
    for (const rule of rules) {
      this.rules.set(rule.id, { ...rule, createdAt: rule.createdAt ?? Date.now() });
    }
    this.notifyListeners();
    this.logger.log(`Imported ${rules.length} dynamic limiter rules`);
  }

  /** 导出所有规则 */
  exportRules(): DynamicLimiterRule[] {
    return Array.from(this.rules.values());
  }

  /** 监听规则变更 */
  onRulesChanged(listener: (rules: DynamicLimiterRule[]) => void): { unsubscribe: () => void } {
    this.listeners.push(listener);
    return {
      unsubscribe: () => {
        const idx = this.listeners.indexOf(listener);
        if (idx >= 0) this.listeners.splice(idx, 1);
      },
    };
  }

  /** 启用/禁用规则 */
  toggleRule(id: string, enabled: boolean): boolean {
    const rule = this.rules.get(id);
    if (!rule) return false;
    rule.enabled = enabled;
    this.notifyListeners();
    return true;
  }

  private notifyListeners(): void {
    const rules = this.getRules();
    for (const listener of this.listeners) {
      try { listener(rules); } catch { /* ignore */ }
    }
  }

  private globToRegex(glob: string): RegExp {
    const escaped = glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`);
  }
}
