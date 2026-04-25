import { Injectable, Logger, Optional, Inject, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  type AlertRule,
  type AlertRecord,
  type AlertSeverity,
} from './alert.interfaces';

/** 每条规则的违规追踪状态 */
interface ViolationState {
  /** 首次违规时间戳 (ms) */
  startedAt: number;
  /** 连续违规次数 */
  count: number;
  /** 最新指标值 */
  lastValue: number;
}

function nextAlertId(): string {
  return `alert-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

@Injectable()
export class AlertManagerService implements OnModuleInit {
  private readonly logger = new Logger(AlertManagerService.name);

  /** 已注册的告警规则 */
  private readonly rules = new Map<string, AlertRule>();

  /** 所有告警记录（含历史） */
  private readonly alerts = new Map<string, AlertRecord>();

  /** 每条规则的持续违规状态 */
  private readonly violations = new Map<string, ViolationState>();

  /** 活跃告警的 ruleId 索引（非 RESOLVED 状态的告警） */
  private readonly activeRuleIds = new Set<string>();

  constructor(
    private readonly eventEmitter: EventEmitter2,
    @Optional() @Inject('DATABASE_ADAPTER') private readonly db?: any,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.db) return;
    try {
      const rules = await this.db.model('alertRules').findMany({}) as AlertRule[];
      for (const rule of rules) {
        this.rules.set(rule.id, rule);
      }
      if (rules.length > 0) {
        this.logger.log(`Loaded ${rules.length} alert rules from database`);
      }
    } catch {
      // alertRules 表可能不存在 — 跳过
    }
  }

  // ─── 规则管理 ───────────────────────────────────────

  registerRule(rule: AlertRule): void {
    this.rules.set(rule.id, { ...rule });
    // 持久化到数据库（如果可用）
    if (this.db) {
      this.db.model('alertRules').update({
        where: { id: rule.id },
        data: { ...rule },
      }).catch(() => {
        this.db!.model('alertRules').create({ data: { ...rule } }).catch((dbErr: unknown) => {
          this.logger.warn(`Failed to persist alert rule ${rule.id} to database: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`);
        });
      });
    }
    this.logger.log(`Alert rule registered: ${rule.name} (${rule.id})`);
  }

  removeRule(ruleId: string): boolean {
    const deleted = this.rules.delete(ruleId);
    if (deleted) {
      this.violations.delete(ruleId);
      this.logger.log(`Alert rule removed: ${ruleId}`);
    }
    return deleted;
  }

  getRules(): AlertRule[] {
    return Array.from(this.rules.values());
  }

  getRule(ruleId: string): AlertRule | undefined {
    return this.rules.get(ruleId);
  }

  // ─── 告警评估 ───────────────────────────────────────

  /**
   * 对一组指标快照评估所有已启用规则。
   * 应由调度器（如 Cron / Interval）定期调用。
   */
  evaluate(metrics: Record<string, number>): AlertRecord[] {
    const triggered: AlertRecord[] = [];
    const now = Date.now();

    for (const rule of this.rules.values()) {
      if (!rule.enabled) continue;

      const value = metrics[rule.metric];
      if (value === undefined) continue;

      const violated = this.checkCondition(value, rule.condition, rule.threshold);

      if (violated) {
        const state = this.violations.get(rule.id);
        if (state) {
          state.count++;
          state.lastValue = value;
        } else {
          this.violations.set(rule.id, {
            startedAt: now,
            count: 1,
            lastValue: value,
          });
        }

        const current = this.violations.get(rule.id)!;
        const elapsedSec = (now - current.startedAt) / 1000;

        // 持续时间达到阈值且尚无活跃告警 → 触发
        if (elapsedSec >= rule.duration && !this.hasActiveAlertForRule(rule.id)) {
          const record = this.createAlert(rule, value);
          triggered.push(record);
        }
      } else {
        // 指标恢复 → 清除违规计数并自动解决活跃告警
        this.violations.delete(rule.id);
        this.autoResolveForRule(rule.id);
      }
    }

    return triggered;
  }

  // ─── 告警查询 ───────────────────────────────────────

  getAlerts(): AlertRecord[] {
    return Array.from(this.alerts.values());
  }

  getActiveAlerts(): AlertRecord[] {
    return Array.from(this.alerts.values()).filter(
      (a) => a.status === 'ACTIVE',
    );
  }

  getAlert(alertId: string): AlertRecord | undefined {
    return this.alerts.get(alertId);
  }

  // ─── 告警操作 ───────────────────────────────────────

  acknowledgeAlert(alertId: string, userId: string): AlertRecord | undefined {
    const alert = this.alerts.get(alertId);
    if (!alert || alert.status !== 'ACTIVE') return undefined;

    alert.status = 'ACKNOWLEDGED';
    alert.acknowledgedAt = Date.now();
    alert.acknowledgedBy = userId;

    this.eventEmitter.emit('alert.acknowledged', { ...alert });
    this.logger.log(`Alert acknowledged: ${alertId} by ${userId}`);
    return { ...alert };
  }

  resolveAlert(alertId: string, userId: string): AlertRecord | undefined {
    const alert = this.alerts.get(alertId);
    if (!alert || alert.status === 'RESOLVED') return undefined;

    alert.status = 'RESOLVED';
    alert.resolvedAt = Date.now();
    alert.resolvedBy = userId;

    this.violations.delete(alert.ruleId);
    // 更新索引：检查是否还有其他非RESOLVED告警
    if (!Array.from(this.alerts.values()).some(a => a.ruleId === alert.ruleId && a.id !== alertId && a.status !== 'RESOLVED')) {
      this.activeRuleIds.delete(alert.ruleId);
    }
    this.eventEmitter.emit('alert.resolved', { ...alert });
    this.logger.log(`Alert resolved: ${alertId} by ${userId}`);
    return { ...alert };
  }

  // ─── 内部方法 ───────────────────────────────────────

  private checkCondition(
    value: number,
    condition: AlertRule['condition'],
    threshold: number,
  ): boolean {
    switch (condition) {
      case '>':
        return value > threshold;
      case '>=':
        return value >= threshold;
      case '<':
        return value < threshold;
      case '<=':
        return value <= threshold;
      case '==':
        return value === threshold;
      case '!=':
        return value !== threshold;
      default:
        return false;
    }
  }

  private hasActiveAlertForRule(ruleId: string): boolean {
    return this.activeRuleIds.has(ruleId);
  }

  private createAlert(rule: AlertRule, value: number): AlertRecord {
    const record: AlertRecord = {
      id: nextAlertId(),
      ruleId: rule.id,
      ruleName: rule.name,
      metric: rule.metric,
      value,
      threshold: rule.threshold,
      severity: rule.severity,
      status: 'ACTIVE',
      message: `${rule.metric} ${rule.condition} ${rule.threshold} (current: ${value})`,
      triggeredAt: Date.now(),
    };

    this.alerts.set(record.id, record);
    this.activeRuleIds.add(rule.id);
    this.eventEmitter.emit('alert.triggered', { ...record });
    this.logger.warn(
      `Alert triggered: [${record.severity}] ${record.message}`,
    );
    return { ...record };
  }

  private autoResolveForRule(ruleId: string): void {
    for (const alert of this.alerts.values()) {
      if (alert.ruleId === ruleId && alert.status !== 'RESOLVED') {
        alert.status = 'RESOLVED';
        alert.resolvedAt = Date.now();
        alert.resolvedBy = 'system';
        this.eventEmitter.emit('alert.resolved', { ...alert });
        this.logger.log(`Alert auto-resolved: ${alert.id} (metric recovered)`);
      }
    }
    // 如果没有剩余的非RESOLVED告警，移除索引
    if (!Array.from(this.alerts.values()).some(a => a.ruleId === ruleId && a.status !== 'RESOLVED')) {
      this.activeRuleIds.delete(ruleId);
    }
  }
}
