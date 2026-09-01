import { Logger } from '@nestjs/common';

export interface NotifyActionConfig {
  notifyType: string;
  templateId?: string;
  recipients: string[];
  title?: string;
  message?: string;
  /** 变量映射（对齐 jetlinks 通知模板变量绑定） */
  variables?: Record<string, string>;
}

/**
 * 通知事件结构 — 通过事件总线发布
 */
export interface NotifyEvent {
  type: string;
  templateId?: string;
  recipients: string[];
  title?: string;
  message?: string;
  data: Record<string, unknown>;
  /** 解析后的变量值 */
  resolvedVariables?: Record<string, unknown>;
}

/**
 * 通知发送函数类型 — 由外部注入实现
 */
export type NotifySender = (event: NotifyEvent) => Promise<void>;

/**
 * 通知动作执行器 — 对齐 jetlinks NotifyTaskExecutorProvider
 *
 * 增强：
 * - 支持变量解析（从 data 中提取模板变量）
 * - 支持外部注入通知发送器
 */
export class NotifyAction {
  private readonly logger = new Logger(NotifyAction.name);
  private sender?: NotifySender;

  /**
   * 设置通知发送器（由模块初始化时注入）
   */
  setSender(sender: NotifySender): void {
    this.sender = sender;
  }

  async execute(
    config: NotifyActionConfig,
    data: Record<string, unknown>,
  ): Promise<void> {
    this.validate(config);

    // 解析变量
    const resolvedVariables: Record<string, unknown> = {};
    if (config.variables) {
      for (const [key, path] of Object.entries(config.variables)) {
        resolvedVariables[key] = this.resolveVariable(path, data);
      }
    }

    // 对 title 和 message 做模板插值
    const title = config.title
      ? this.interpolate(config.title, data)
      : undefined;
    const message = config.message
      ? this.interpolate(config.message, data)
      : undefined;

    const event: NotifyEvent = {
      type: config.notifyType,
      templateId: config.templateId,
      recipients: config.recipients,
      title,
      message,
      data,
      resolvedVariables,
    };

    this.logger.log(
      `Sending notification: type=${config.notifyType}, recipients=${config.recipients.join(',')}`,
    );

    if (this.sender) {
      await this.sender(event);
    } else {
      this.logger.debug(
        `Notification event (no sender configured): ${JSON.stringify(event)}`,
      );
    }
  }

  /**
   * 验证通知配置
   */
  validate(config: NotifyActionConfig): void {
    if (!config.notifyType || config.notifyType.trim().length === 0) {
      throw new Error('Notify type is required');
    }
    if (!config.recipients || config.recipients.length === 0) {
      throw new Error('At least one recipient is required');
    }
  }

  /**
   * 解析变量路径 — 对齐 jetlinks VariableSource 解析
   */
  private resolveVariable(
    path: string,
    data: Record<string, unknown>,
  ): unknown {
    if (!path.includes('.')) {
      return data[path];
    }
    const parts = path.split('.');
    let current: unknown = data;
    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      if (typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  private interpolate(
    template: string,
    data: Record<string, unknown>,
  ): string {
    return template.replace(/\$\{([^}]+)}/g, (_, path: string) => {
      const value = this.resolveVariable(path.trim(), data);
      return value !== undefined && value !== null ? String(value) : '';
    });
  }
}
