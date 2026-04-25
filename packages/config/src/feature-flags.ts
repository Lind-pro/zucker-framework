import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';

/**
 * Feature Flag 渐进发布 — 对标 Claude Code growthbook.ts 三层评估模式
 *
 * 评估优先级（高 → 低）:
 * 1. 环境变量覆写 (FF_<FLAG_NAME>=true/false，确定性测试)
 * 2. 用户/租户级覆写 (per-context overrides)
 * 3. 规则评估 (百分比灰度、条件匹配)
 * 4. 默认值
 *
 * 用法:
 * ```ts
 * const flags = new FeatureFlagService();
 *
 * flags.register({
 *   key: 'new_dashboard',
 *   defaultValue: false,
 *   rules: [
 *     { type: 'percentage', percentage: 20 },        // 20% 用户看到
 *     { type: 'allowlist', values: ['tenant-vip'] },  // VIP 租户始终看到
 *   ],
 * });
 *
 * const enabled = flags.isEnabled('new_dashboard', { userId: 'u1', tenantId: 't1' });
 * ```
 */

export interface FlagContext {
  userId?: string;
  tenantId?: string;
  roles?: string[];
  attributes?: Record<string, string | number | boolean>;
}

export type FlagRuleType = 'percentage' | 'allowlist' | 'blocklist' | 'attribute';

export interface FlagRule {
  type: FlagRuleType;
  /** 百分比 (0-100)，仅 type=percentage 时使用 */
  percentage?: number;
  /** 允许/阻止列表值，匹配 tenantId 或 userId */
  values?: string[];
  /** 属性匹配条件，仅 type=attribute 时使用 */
  attribute?: { key: string; operator: 'eq' | 'neq' | 'in'; value: unknown };
}

export interface FlagDefinition {
  key: string;
  description?: string;
  defaultValue: boolean;
  rules?: FlagRule[];
  /** 是否启用（全局开关，false 则直接返回 defaultValue） */
  enabled?: boolean;
}

const ENV_PREFIX = 'FF_';

@Injectable()
export class FeatureFlagService {
  private readonly logger = new Logger(FeatureFlagService.name);
  private readonly flags = new Map<string, FlagDefinition>();
  private readonly overrides = new Map<string, Map<string, boolean>>(); // flagKey → (contextKey → value)
  private readonly loggedExposures = new Set<string>(); // 去重曝光日志

  /**
   * 注册特性标志
   */
  register(definition: FlagDefinition): void {
    this.flags.set(definition.key, definition);
  }

  /**
   * 批量注册
   */
  registerAll(definitions: FlagDefinition[]): void {
    for (const def of definitions) {
      this.register(def);
    }
  }

  /**
   * 评估特性标志（核心方法）
   */
  isEnabled(key: string, context: FlagContext = {}): boolean {
    // Layer 1: 环境变量覆写（最高优先级，确定性测试用）
    const envKey = `${ENV_PREFIX}${key.toUpperCase().replace(/[.-]/g, '_')}`;
    const envValue = process.env[envKey];
    if (envValue !== undefined) {
      return envValue === 'true' || envValue === '1';
    }

    const flag = this.flags.get(key);
    if (!flag) return false;
    if (flag.enabled === false) return flag.defaultValue;

    // Layer 2: 用户/租户级覆写
    const overrideMap = this.overrides.get(key);
    if (overrideMap) {
      if (context.userId && overrideMap.has(`user:${context.userId}`)) {
        return overrideMap.get(`user:${context.userId}`)!;
      }
      if (context.tenantId && overrideMap.has(`tenant:${context.tenantId}`)) {
        return overrideMap.get(`tenant:${context.tenantId}`)!;
      }
    }

    // Layer 3: 规则评估
    if (flag.rules && flag.rules.length > 0) {
      for (const rule of flag.rules) {
        const result = this.evaluateRule(rule, key, context);
        if (result !== undefined) return result;
      }
    }

    // Layer 4: 默认值
    return flag.defaultValue;
  }

  /**
   * 获取特性标志的值（泛型版本，支持非 boolean）
   */
  getValue<T>(key: string, defaultValue: T): T {
    const flag = this.flags.get(key);
    if (!flag) return defaultValue;
    return (flag as unknown as { value?: T }).value ?? defaultValue;
  }

  /**
   * 设置用户级覆写
   */
  setUserOverride(flagKey: string, userId: string, value: boolean): void {
    this.getOrCreateOverrideMap(flagKey).set(`user:${userId}`, value);
  }

  /**
   * 设置租户级覆写
   */
  setTenantOverride(flagKey: string, tenantId: string, value: boolean): void {
    this.getOrCreateOverrideMap(flagKey).set(`tenant:${tenantId}`, value);
  }

  /**
   * 清除覆写
   */
  clearOverride(flagKey: string, contextKey: string): void {
    this.overrides.get(flagKey)?.delete(contextKey);
  }

  /**
   * 清除所有覆写
   */
  clearAllOverrides(flagKey?: string): void {
    if (flagKey) {
      this.overrides.delete(flagKey);
    } else {
      this.overrides.clear();
    }
  }

  /**
   * 获取所有已注册的标志定义
   */
  getAllFlags(): FlagDefinition[] {
    return [...this.flags.values()];
  }

  /**
   * 获取标志定义
   */
  getFlag(key: string): FlagDefinition | undefined {
    return this.flags.get(key);
  }

  private evaluateRule(rule: FlagRule, flagKey: string, context: FlagContext): boolean | undefined {
    switch (rule.type) {
      case 'percentage': {
        if (rule.percentage === undefined) return undefined;
        if (rule.percentage >= 100) return true;
        if (rule.percentage <= 0) return false;
        // 基于 userId + flagKey 的稳定哈希，确保同一用户始终得到相同结果
        const identifier = context.userId ?? context.tenantId ?? 'anonymous';
        const hash = this.stableHash(`${flagKey}:${identifier}`);
        return (hash % 100) < rule.percentage;
      }

      case 'allowlist': {
        if (!rule.values?.length) return undefined;
        const ids = [context.userId, context.tenantId].filter(Boolean) as string[];
        if (ids.some((id) => rule.values!.includes(id))) return true;
        if (context.roles?.some((role) => rule.values!.includes(role))) return true;
        return undefined; // 不在白名单中，继续下一条规则
      }

      case 'blocklist': {
        if (!rule.values?.length) return undefined;
        const ids = [context.userId, context.tenantId].filter(Boolean) as string[];
        if (ids.some((id) => rule.values!.includes(id))) return false;
        return undefined;
      }

      case 'attribute': {
        if (!rule.attribute || !context.attributes) return undefined;
        const attrValue = context.attributes[rule.attribute.key];
        if (attrValue === undefined) return undefined;

        switch (rule.attribute.operator) {
          case 'eq': return attrValue === rule.attribute.value ? true : undefined;
          case 'neq': return attrValue !== rule.attribute.value ? true : undefined;
          case 'in': return Array.isArray(rule.attribute.value) && (rule.attribute.value as unknown[]).includes(attrValue) ? true : undefined;
          default: return undefined;
        }
      }

      default:
        return undefined;
    }
  }

  /** 稳定哈希：同一输入始终产生同一数字（0-99） */
  private stableHash(input: string): number {
    const hash = createHash('md5').update(input).digest();
    return ((hash[0]! << 8) | hash[1]!) % 100;
  }

  private getOrCreateOverrideMap(flagKey: string): Map<string, boolean> {
    let map = this.overrides.get(flagKey);
    if (!map) {
      map = new Map();
      this.overrides.set(flagKey, map);
    }
    return map;
  }
}
