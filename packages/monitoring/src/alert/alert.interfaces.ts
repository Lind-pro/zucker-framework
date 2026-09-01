export type AlertSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type AlertStatus = 'ACTIVE' | 'ACKNOWLEDGED' | 'RESOLVED';

export interface AlertRule {
  id: string;
  name: string;
  metric: string;
  condition: '>' | '>=' | '<' | '<=' | '==' | '!=';
  threshold: number;
  /** 持续违规秒数，超过后触发告警 */
  duration: number;
  severity: AlertSeverity;
  enabled: boolean;
  /** 通知渠道标识列表 */
  notifyChannels?: string[];
}

export interface AlertRecord {
  id: string;
  ruleId: string;
  ruleName: string;
  metric: string;
  value: number;
  threshold: number;
  severity: AlertSeverity;
  status: AlertStatus;
  message: string;
  triggeredAt: number;
  acknowledgedAt?: number;
  resolvedAt?: number;
  acknowledgedBy?: string;
  resolvedBy?: string;
}
